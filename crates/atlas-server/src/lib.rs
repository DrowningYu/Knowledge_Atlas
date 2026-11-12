use anyhow::{anyhow, Result};
use atlas_core::Store;
use axum::{
    extract::{Request, State},
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use rmcp::{
    model::*,
    service::RequestContext,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    RoleServer, ServerHandler,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
pub struct ServerOptions {
    pub port: u16,
    pub token: String,
    pub allowed_origins: Vec<String>,
}
#[derive(Clone)]
pub struct ServerHandle {
    pub port: u16,
    pub token: String,
    cancel: CancellationToken,
    last_seen: Arc<AtomicU64>,
}
impl ServerHandle {
    pub fn shutdown(&self) {
        self.cancel.cancel();
    }
    pub fn info(&self) -> Value {
        let url = format!("http://127.0.0.1:{}/mcp", self.port);
        let seen = self.last_seen.load(Ordering::Relaxed);
        json!({"url":url,"token":self.token,"port":self.port,"running":!self.cancel.is_cancelled(),"last_seen":if seen==0{None}else{Some(seen)},"client_config":{"mcpServers":{"knowledge-atlas":{"url":url,"headers":{"Authorization":format!("Bearer {}",self.token)}}}}})
    }
}
#[derive(Clone)]
struct AppState {
    store: Store,
    token: String,
    origins: Vec<String>,
    last_seen: Arc<AtomicU64>,
    port: u16,
    cancel: CancellationToken,
}
pub fn dispatch(store: &Store, method: &str, params: Value) -> Result<Value> {
    fn s<'a>(p: &'a Value, k: &str) -> Result<&'a str> {
        p.get(k)
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("missing string field: {k}"))
    }
    let id = || s(&params, "map_id");
    Ok(match method {
        "list_maps" => serde_json::to_value(store.list_maps()?)?,
        "create_map" => {
            serde_json::to_value(store.create_map(s(&params, "title")?, s(&params, "target")?)?)?
        }
        "get_map" => serde_json::to_value(store.get_map(id()?)?)?,
        "get_node" => serde_json::to_value(store.get_node(id()?, s(&params, "node_id")?)?)?,
        "apply_graph_patch" => {
            serde_json::to_value(store.apply_graph_patch(serde_json::from_value(params)?)?)?
        }
        "delete_map" => {
            store.delete_map(
                id()?,
                params
                    .get("expected_version")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| anyhow!("missing expected_version"))?,
            )?;
            json!({"ok":true})
        }
        "undo" => serde_json::to_value(store.undo(id()?)?)?,
        "redo" => serde_json::to_value(store.redo(id()?)?)?,
        "restore_deleted_map" => serde_json::to_value(store.restore_deleted_map()?)?,
        "import_graph" => serde_json::to_value(
            store.import_graph(serde_json::from_value(
                params
                    .get("graph")
                    .cloned()
                    .ok_or_else(|| anyhow!("missing graph"))?,
            )?)?,
        )?,
        "export_outline" => json!({"text":store.export_outline(id()?,s(&params,"format")?)?}),
        "recommend" => serde_json::to_value(store.recommend(id()?)?)?,
        _ => return Err(anyhow!("unknown method: {method}")),
    })
}
fn error(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({"error":msg}))).into_response()
}
fn token_equal(a: &[u8], b: &[u8]) -> bool {
    let mut d = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        d |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    d == 0
}
fn cors(h: &mut axum::http::HeaderMap, o: Option<HeaderValue>) {
    if let Some(o) = o {
        h.insert("access-control-allow-origin", o);
        h.insert("vary", HeaderValue::from_static("Origin"));
        h.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
        );
        h.insert("access-control-allow-headers",HeaderValue::from_static("Authorization, Content-Type, Accept, MCP-Session-Id, MCP-Protocol-Version, Last-Event-ID"));
        h.insert(
            "access-control-expose-headers",
            HeaderValue::from_static("MCP-Session-Id, MCP-Protocol-Version"),
        );
    }
}
async fn guard(State(s): State<AppState>, req: Request, next: Next) -> Response {
    let h = req.headers();
    let host = h
        .get("host")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<axum::http::uri::Authority>().ok());
    if !host.is_some_and(|a| matches!(a.host(), "localhost" | "127.0.0.1" | "[::1]")) {
        return error(StatusCode::FORBIDDEN, "loopback Host required");
    }
    let origin = h.get("origin").cloned();
    if origin.as_ref().is_some_and(|o| {
        !o.to_str()
            .ok()
            .is_some_and(|o| s.origins.iter().any(|x| x == o))
    }) {
        return error(StatusCode::FORBIDDEN, "Origin not allowed");
    }
    if req.method() == axum::http::Method::OPTIONS {
        if origin.is_none() {
            return error(StatusCode::FORBIDDEN, "Origin required");
        }
        let mut r = StatusCode::NO_CONTENT.into_response();
        cors(r.headers_mut(), origin);
        return r;
    }
    if req.uri().path() != "/healthz" {
        let token = h
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("");
        if !token_equal(token.as_bytes(), s.token.as_bytes()) {
            return error(StatusCode::UNAUTHORIZED, "Bearer token required");
        }
        if req.uri().path().starts_with("/mcp") {
            s.last_seen.store(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                Ordering::Relaxed,
            );
        }
    }
    let mut r = next.run(req).await;
    cors(r.headers_mut(), origin);
    r
}
#[derive(Deserialize)]
struct ApiRequest {
    method: String,
    #[serde(default)]
    params: Value,
}
async fn api(State(s): State<AppState>, Json(r): Json<ApiRequest>) -> Response {
    if r.method == "connection_info" {
        return Json(
            ServerHandle {
                port: s.port,
                token: s.token.clone(),
                cancel: s.cancel.clone(),
                last_seen: s.last_seen.clone(),
            }
            .info(),
        )
        .into_response();
    }
    match dispatch(&s.store, &r.method, r.params) {
        Ok(v) => Json(v).into_response(),
        Err(e) => error(
            if e.to_string().to_lowercase().contains("conflict") {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            },
            &e.to_string(),
        ),
    }
}
async fn events(State(s): State<AppState>) -> impl IntoResponse {
    let mut rx = s.store.subscribe();
    Sse::new(async_stream::stream!{loop{match rx.recv().await{Ok(c)=>yield Ok::<_,Infallible>(Event::default().event("change").data(serde_json::to_string(&c).unwrap_or_default())),Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>yield Ok(Event::default().event("resync").data("{}")),Err(_)=>break}}}).keep_alive(KeepAlive::default())
}
#[derive(Clone)]
struct AtlasMcp {
    store: Store,
}
fn operation_schema() -> Value {
    let text = json!({"type":"string"});
    let node = json!({"type":"object","properties":{"id":text,"title":text,"summary":text,"explanation":text,"status":{"type":"string","enum":["not_understood","learning","mastered","skipped"]},"notes":text,"collapsed":{"type":"boolean"}},"required":["id","title","summary","explanation","status","notes","collapsed"],"additionalProperties":false});
    let edge = json!({"type":"object","properties":{"id":text,"source":text,"target":text,"kind":{"type":"string","enum":["required","recommended","related"]},"reason":text},"required":["id","source","target","kind","reason"],"additionalProperties":false});
    let variants = [
        ("upsert_node", "node", node),
        ("delete_node", "node_id", text.clone()),
        ("upsert_edge", "edge", edge),
        ("delete_edge", "edge_id", text.clone()),
        ("rename_map", "title", text.clone()),
        ("set_root", "node_id", text),
    ];
    json!({"oneOf":variants.into_iter().map(|(op,key,value)|{let mut properties=serde_json::Map::new();properties.insert("op".into(),json!({"const":op}));properties.insert(key.into(),value);json!({"type":"object","properties":properties,"required":["op",key],"additionalProperties":false})}).collect::<Vec<_>>()})
}
fn tools() -> Vec<Tool> {
    [
 ("list_maps","List maps",json!({}),vec![]),
 ("create_map","Create map",json!({"title":{"type":"string"},"target":{"type":"string"}}),vec!["title","target"]),
 ("get_map","Read map and current version",json!({"map_id":{"type":"string"}}),vec!["map_id"]),
 ("get_node","Read node",json!({"map_id":{"type":"string"},"node_id":{"type":"string"}}),vec!["map_id","node_id"]),
 ("apply_graph_patch","Atomic version checked patch. Operations: upsert_node {node:{id,title,summary,explanation,status,notes,collapsed}}, delete_node {node_id}, upsert_edge {edge:{id,source,target,kind,reason}}, delete_edge {edge_id}, rename_map {title}, set_root {node_id}. All fields explicit; status not_understood/learning/mastered/skipped; kind required/recommended/related. Dependencies form DAG. Conflicts leave map unchanged.",json!({"map_id":{"type":"string"},"expected_version":{"type":"integer","minimum":0},"operations":{"type":"array","items":operation_schema()}}),vec!["map_id","expected_version","operations"]),
 ("export_outline","Export markdown, mermaid or json",json!({"map_id":{"type":"string"},"format":{"type":"string","enum":["markdown","mermaid","json"]}}),vec!["map_id","format"])
 ].into_iter().map(|(n,d,p,r)|{let mut tool=Tool::new(n,d,json!({"type":"object","properties":p,"required":r,"additionalProperties":false}).as_object().unwrap().clone());tool.annotations=Some(ToolAnnotations::new().read_only(!matches!(n,"create_map"|"apply_graph_patch")).destructive(n=="apply_graph_patch").open_world(false));tool}).collect()
}
impl ServerHandler for AtlasMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, rmcp::ErrorData> {
        Ok(ListToolsResult {
            tools: tools(),
            ..Default::default()
        })
    }
    fn get_tool(&self, n: &str) -> Option<Tool> {
        tools().into_iter().find(|t| t.name == n)
    }
    async fn call_tool(
        &self,
        r: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, rmcp::ErrorData> {
        let result = if self.get_tool(&r.name).is_none() {
            Err(anyhow!("unknown tool"))
        } else {
            dispatch(
                &self.store,
                &r.name,
                Value::Object(r.arguments.unwrap_or_default()),
            )
        };
        Ok(match result {
            Ok(v) => CallToolResult::success(vec![ContentBlock::text(v.to_string())]),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(e.to_string())]),
        }
        .into())
    }
}
fn valid_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    origin.parse::<axum::http::Uri>().ok().is_some_and(|u| {
        matches!(u.scheme_str(), Some("http" | "https"))
            && matches!(u.host(), Some("localhost" | "127.0.0.1" | "[::1]"))
            && u.path_and_query().is_none_or(|p| p.as_str() == "/")
            && !origin.ends_with('/')
    })
}
pub async fn start(store: Store, o: ServerOptions) -> Result<ServerHandle> {
    if o.token.len() < 32 || o.token.chars().any(char::is_whitespace) {
        return Err(anyhow!(
            "token must contain at least 32 non-whitespace characters"
        ));
    }
    let listener =
        match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, o.port)).await {
            Ok(l) => l,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?
            }
            Err(e) => return Err(e.into()),
        };
    let port = listener.local_addr()?.port();
    let cancel = CancellationToken::new();
    let last_seen = Arc::new(AtomicU64::new(0));
    let mut origins = vec![
        "tauri://localhost".into(),
        "http://tauri.localhost".into(),
        "https://tauri.localhost".into(),
    ];
    for origin in o.allowed_origins {
        if !valid_origin(&origin) {
            return Err(anyhow!("invalid allowed Origin"));
        }
        origins.push(origin);
    }
    let state = AppState {
        store: store.clone(),
        token: o.token.clone(),
        origins,
        last_seen: last_seen.clone(),
        port,
        cancel: cancel.clone(),
    };
    let mcp: StreamableHttpService<AtlasMcp, LocalSessionManager> = StreamableHttpService::new(
        move || {
            Ok(AtlasMcp {
                store: store.clone(),
            })
        },
        Default::default(),
        StreamableHttpServerConfig::default().with_cancellation_token(cancel.child_token()),
    );
    let router = Router::new()
        .route("/api", post(api))
        .route("/events", get(events))
        .route("/healthz", get(|| async { Json(json!({"ok":true})) }))
        .nest_service("/mcp", mcp)
        .with_state(state.clone())
        .layer(tower_http::limit::RequestBodyLimitLayer::new(
            2 * 1024 * 1024,
        ))
        .layer(middleware::from_fn_with_state(state, guard));
    let shutdown = cancel.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await;
    });
    Ok(ServerHandle {
        port,
        token: o.token,
        cancel,
        last_seen,
    })
}
