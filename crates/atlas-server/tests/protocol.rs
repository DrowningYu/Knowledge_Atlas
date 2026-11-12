use atlas_core::Store;
use atlas_server::{dispatch, start, ServerOptions};
use rmcp::{
    model::{CallToolRequestParams, ClientConfig, ProtocolVersion},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};
use serde_json::{json, Value};
#[tokio::test]
async fn official_sdk_roundtrip_and_security() -> anyhow::Result<()> {
    let store = Store::open(":memory:")?;
    let token = "0123456789abcdef0123456789abcdef";
    let server = start(
        store.clone(),
        ServerOptions {
            port: 0,
            token: token.into(),
            allowed_origins: vec!["http://localhost:5173".into()],
        },
    )
    .await?;
    let base = format!("http://127.0.0.1:{}", server.port);
    let http = reqwest::Client::new();
    for route in ["/api", "/events", "/mcp"] {
        let r = http.get(format!("{base}{route}")).send().await?;
        assert_eq!(r.status(), 401);
    }
    for origin in ["null", "https://attacker.invalid"] {
        assert_eq!(
            http.get(format!("{base}/events"))
                .bearer_auth(token)
                .header("Origin", origin)
                .send()
                .await?
                .status(),
            403
        );
    }
    assert_eq!(
        http.get(format!("{base}/healthz"))
            .header("Host", "attacker.invalid")
            .send()
            .await?
            .status(),
        403
    );
    assert_eq!(
        http.request(reqwest::Method::OPTIONS, format!("{base}/api"))
            .header("Origin", "http://localhost:5173")
            .send()
            .await?
            .status(),
        204
    );
    let mut cfg = StreamableHttpClientTransportConfig::with_uri(format!("{base}/mcp"));
    cfg.auth_header = Some(token.into());
    let transport = StreamableHttpClientTransport::from_config(cfg);
    let client = ClientConfig::default()
        .with_protocol_version(ProtocolVersion::LATEST_WITH_INITIALIZE)
        .serve(transport)
        .await?;
    let listed = client.list_tools(None).await?;
    assert_eq!(listed.tools.len(), 6);
    let mut event_response = http
        .get(format!("{base}/events"))
        .bearer_auth(token)
        .send()
        .await?;
    let created = client
        .call_tool(
            CallToolRequestParams::new("create_map").with_arguments(
                json!({"title":"Protocol","target":"Control"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await?;
    assert_ne!(created.is_error, Some(true));
    let event = tokio::time::timeout(std::time::Duration::from_secs(3), event_response.chunk())
        .await??
        .unwrap();
    assert!(String::from_utf8_lossy(&event).contains("event: change"));
    drop(event_response);
    let graph: Value = serde_json::from_str(&created.content[0].as_text().unwrap().text)?;
    let id = graph["id"].as_str().unwrap();
    let version = graph["version"].as_u64().unwrap();
    let patch = json!({"map_id":id,"expected_version":version,"operations":[{"op":"rename_map","title":"Edited"}]});
    let call = || {
        CallToolRequestParams::new("apply_graph_patch")
            .with_arguments(patch.as_object().unwrap().clone())
    };
    assert_ne!(client.call_tool(call()).await?.is_error, Some(true));
    let conflict = client.call_tool(call()).await?;
    assert_eq!(conflict.is_error, Some(true));
    assert!(conflict.content[0]
        .as_text()
        .unwrap()
        .text
        .to_lowercase()
        .contains("conflict"));
    let updated = store.get_map(id)?;
    assert_eq!(updated.title, "Edited");
    let bad = json!({"map_id":id,"expected_version":updated.version,"operations":[{"op":"rename_map","title":"Never"},{"op":"set_root","node_id":"missing"}]});
    assert!(dispatch(&store, "apply_graph_patch", bad).is_err());
    assert_eq!(store.get_map(id)?.title, "Edited");
    dispatch(&store, "undo", json!({"map_id":id}))?;
    assert_eq!(store.get_map(id)?.title, "Protocol");
    dispatch(&store, "redo", json!({"map_id":id}))?;
    let v = store.get_map(id)?.version;
    dispatch(
        &store,
        "delete_map",
        json!({"map_id":id,"expected_version":v}),
    )?;
    assert!(store.get_map(id).is_err());
    dispatch(&store, "restore_deleted_map", json!({}))?;
    assert!(store.get_map(id).is_ok());
    assert!(server.info()["last_seen"].is_number());
    assert_eq!(
        http.post(format!("{base}/api"))
            .bearer_auth(token)
            .header("Content-Type", "application/json")
            .body("x".repeat(2 * 1024 * 1024 + 1))
            .send()
            .await?
            .status(),
        413
    );
    client.cancel().await?;
    server.shutdown();
    Ok(())
}
