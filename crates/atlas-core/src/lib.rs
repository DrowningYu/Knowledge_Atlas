use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    NotUnderstood,
    Learning,
    Mastered,
    Skipped,
}
pub type NodeStatus = Status;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Node {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub explanation: String,
    pub status: Status,
    pub notes: String,
    pub collapsed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    Required,
    Recommended,
    Related,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Edge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub kind: EdgeKind,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Graph {
    pub id: String,
    pub title: String,
    pub root_id: String,
    pub version: u64,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapSummary {
    pub id: String,
    pub title: String,
    pub root_id: String,
    pub version: u64,
    pub updated_at: String,
    pub node_count: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Patch {
    pub map_id: String,
    pub expected_version: u64,
    pub operations: Vec<Operation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Operation {
    UpsertNode { node: Node },
    DeleteNode { node_id: String },
    UpsertEdge { edge: Edge },
    DeleteEdge { edge_id: String },
    RenameMap { title: String },
    SetRoot { node_id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Change {
    pub map_id: String,
    pub version: u64,
    pub kind: String,
}
#[derive(Clone)]
pub struct Store {
    db: Arc<Mutex<Connection>>,
    changes: broadcast::Sender<Change>,
}
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn validate(g: &Graph) -> Result<()> {
    if !valid_id(&g.id) {
        bail!("invalid map ID")
    };
    if g.title.trim().is_empty() {
        bail!("map title is empty")
    };
    let mut ids = HashSet::new();
    for n in &g.nodes {
        if !valid_id(&n.id) || !ids.insert(n.id.as_str()) {
            bail!("invalid or duplicate node ID: {}", n.id)
        }
        if n.title.trim().is_empty() {
            bail!("node title is empty")
        }
    }
    if !ids.contains(g.root_id.as_str()) {
        bail!("root references missing node")
    }
    let mut eids = HashSet::new();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in &g.edges {
        if !valid_id(&e.id) || !eids.insert(e.id.as_str()) {
            bail!("invalid or duplicate edge ID: {}", e.id)
        }
        if !ids.contains(e.source.as_str()) || !ids.contains(e.target.as_str()) {
            bail!("edge references missing node")
        };
        if e.source == e.target {
            bail!("self edges are forbidden")
        };
        if e.kind != EdgeKind::Related {
            adjacency.entry(&e.source).or_default().push(&e.target);
        }
    }
    // Kahn's algorithm avoids recursion limits for large imported dependency graphs.
    let mut pending: HashMap<&str, usize> = ids.iter().map(|id| (*id, 0)).collect();
    for targets in adjacency.values() {
        for target in targets {
            *pending.get_mut(target).unwrap() += 1;
        }
    }
    let mut ready: Vec<_> = pending
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut visited = 0;
    while let Some(id) = ready.pop() {
        visited += 1;
        if let Some(targets) = adjacency.get(id) {
            for target in targets {
                let count = pending.get_mut(target).unwrap();
                *count -= 1;
                if *count == 0 {
                    ready.push(*target);
                }
            }
        }
    }
    if visited != ids.len() {
        bail!("dependency cycle")
    };
    Ok(())
}
fn load(c: &Connection, id: &str) -> Result<Graph> {
    let s: String = c
        .query_row("SELECT graph FROM maps WHERE id=?1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| anyhow!("map not found: {id}"))?;
    Ok(serde_json::from_str(&s)?)
}
fn save(tx: &Transaction<'_>, g: &Graph) -> Result<()> {
    let cursor: i64 = tx.query_row("SELECT cursor FROM maps WHERE id=?1", [&g.id], |r| r.get(0))?;
    let json = serde_json::to_string(g)?;
    tx.execute(
        "DELETE FROM history WHERE map_id=?1 AND position>?2",
        params![g.id, cursor],
    )?;
    tx.execute(
        "INSERT INTO history(map_id,position,graph) VALUES(?1,?2,?3)",
        params![g.id, cursor + 1, json],
    )?;
    tx.execute(
        "UPDATE maps SET graph=?2,cursor=?3 WHERE id=?1",
        params![g.id, json, cursor + 1],
    )?;
    Ok(())
}
impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let c = Connection::open(path)?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let schema_version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if schema_version > 1 {
            bail!("database schema is newer than this application");
        }
        if schema_version == 0 {
            c.execute_batch(include_str!("../migrations/001_initial.sql"))?;
        }
        let (changes, _) = broadcast::channel(256);
        Ok(Self {
            db: Arc::new(Mutex::new(c)),
            changes,
        })
    }
    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))
    }
    fn emit(&self, g: &Graph, kind: &str) {
        let _ = self.changes.send(Change {
            map_id: g.id.clone(),
            version: g.version,
            kind: kind.into(),
        });
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Change> {
        self.changes.subscribe()
    }
    pub fn list_maps(&self) -> Result<Vec<MapSummary>> {
        let c = self.lock()?;
        let mut q = c.prepare("SELECT graph FROM maps ORDER BY id")?;
        let values = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        values
            .into_iter()
            .map(|s| {
                let g: Graph = serde_json::from_str(&s)?;
                Ok(MapSummary {
                    id: g.id,
                    title: g.title,
                    root_id: g.root_id,
                    version: g.version,
                    updated_at: g.updated_at,
                    node_count: g.nodes.len(),
                })
            })
            .collect()
    }
    pub fn get_map(&self, id: &str) -> Result<Graph> {
        load(&*self.lock()?, id)
    }
    pub fn get_node(&self, map_id: &str, node_id: &str) -> Result<Node> {
        self.get_map(map_id)?
            .nodes
            .into_iter()
            .find(|n| n.id == node_id)
            .ok_or_else(|| anyhow!("node not found: {node_id}"))
    }
    pub fn create_map(&self, title: &str, target: &str) -> Result<Graph> {
        let root = Node {
            id: uuid::Uuid::new_v4().to_string(),
            title: target.into(),
            summary: String::new(),
            explanation: String::new(),
            status: Status::NotUnderstood,
            notes: String::new(),
            collapsed: false,
        };
        self.import_graph(Graph {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            root_id: root.id.clone(),
            version: 1,
            nodes: vec![root],
            edges: vec![],
            updated_at: now(),
        })
    }
    pub fn import_graph(&self, mut g: Graph) -> Result<Graph> {
        validate(&g)?;
        g.version = 1;
        g.updated_at = now();
        let mut c = self.lock()?;
        let tx = c.transaction()?;
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM maps WHERE id=?1 UNION ALL SELECT 1 FROM deleted WHERE json_extract(graph,'$.id')=?1)",[&g.id],|r|r.get(0))?;
        if exists {
            bail!("map ID already exists (including deleted maps)")
        };
        let s = serde_json::to_string(&g)?;
        tx.execute("INSERT INTO maps VALUES(?1,?2,0)", params![g.id, s])?;
        tx.execute("INSERT INTO history VALUES(?1,0,?2)", params![g.id, s])?;
        tx.commit()?;
        self.emit(&g, "created");
        Ok(g)
    }
    pub fn apply_graph_patch(&self, patch: Patch) -> Result<Graph> {
        let mut c = self.lock()?;
        let tx = c.transaction()?;
        let mut g = load(&tx, &patch.map_id)?;
        if g.version != patch.expected_version {
            bail!(
                "version conflict: expected {}, current {}",
                patch.expected_version,
                g.version
            )
        };
        for op in patch.operations {
            match op {
                Operation::UpsertNode { node } => {
                    if let Some(old) = g.nodes.iter_mut().find(|n| n.id == node.id) {
                        *old = node
                    } else {
                        g.nodes.push(node)
                    }
                }
                Operation::DeleteNode { node_id } => {
                    if !valid_id(&node_id) {
                        bail!("invalid node ID: {node_id}");
                    }
                    if !g.nodes.iter().any(|node| node.id == node_id) {
                        bail!("node not found: {node_id}");
                    }
                    g.nodes.retain(|n| n.id != node_id);
                    g.edges
                        .retain(|e| e.source != node_id && e.target != node_id)
                }
                Operation::UpsertEdge { edge } => {
                    if let Some(old) = g.edges.iter_mut().find(|e| e.id == edge.id) {
                        *old = edge
                    } else {
                        g.edges.push(edge)
                    }
                }
                Operation::DeleteEdge { edge_id } => {
                    if !valid_id(&edge_id) {
                        bail!("invalid edge ID: {edge_id}");
                    }
                    if !g.edges.iter().any(|edge| edge.id == edge_id) {
                        bail!("edge not found: {edge_id}");
                    }
                    g.edges.retain(|e| e.id != edge_id);
                }
                Operation::RenameMap { title } => g.title = title,
                Operation::SetRoot { node_id } => g.root_id = node_id,
            }
        }
        validate(&g)?;
        g.version = g.version.checked_add(1).context("version exhausted")?;
        g.updated_at = now();
        save(&tx, &g)?;
        tx.commit()?;
        self.emit(&g, "patched");
        Ok(g)
    }
    pub fn delete_map(&self, id: &str, expected_version: u64) -> Result<()> {
        if !valid_id(id) {
            bail!("invalid map ID: {id}");
        }
        let mut c = self.lock()?;
        let tx = c.transaction()?;
        let mut g = load(&tx, id)?;
        if g.version != expected_version {
            bail!(
                "version conflict: expected {expected_version}, current {}",
                g.version
            )
        };
        g.version = g.version.checked_add(1).context("version exhausted")?;
        g.updated_at = now();
        tx.execute(
            "INSERT INTO deleted(graph,cursor) SELECT ?2,cursor FROM maps WHERE id=?1",
            params![id, serde_json::to_string(&g)?],
        )?;
        tx.execute("DELETE FROM maps WHERE id=?1", [id])?;
        tx.commit()?;
        self.emit(&g, "deleted");
        Ok(())
    }
    pub fn restore_deleted_map(&self) -> Result<Graph> {
        let mut c = self.lock()?;
        let tx = c.transaction()?;
        let (seq, s, cursor): (i64, String, i64) = tx
            .query_row(
                "SELECT sequence,graph,cursor FROM deleted ORDER BY sequence DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| anyhow!("no deleted map to restore"))?;
        let mut g: Graph = serde_json::from_str(&s)?;
        g.version = g.version.checked_add(1).context("version exhausted")?;
        g.updated_at = now();
        tx.execute(
            "INSERT INTO maps VALUES(?1,?2,?3)",
            params![g.id, serde_json::to_string(&g)?, cursor],
        )?;
        tx.execute("DELETE FROM deleted WHERE sequence=?1", [seq])?;
        tx.commit()?;
        self.emit(&g, "restored");
        Ok(g)
    }
    fn travel(&self, id: &str, delta: i64) -> Result<Graph> {
        let mut c = self.lock()?;
        let tx = c.transaction()?;
        let current = load(&tx, id)?;
        let cursor: i64 =
            tx.query_row("SELECT cursor FROM maps WHERE id=?1", [id], |r| r.get(0))?;
        let next = cursor + delta;
        let s: String = tx
            .query_row(
                "SELECT graph FROM history WHERE map_id=?1 AND position=?2",
                params![id, next],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| anyhow!("nothing to {}", if delta < 0 { "undo" } else { "redo" }))?;
        let mut g: Graph = serde_json::from_str(&s)?;
        g.version = current
            .version
            .checked_add(1)
            .context("version exhausted")?;
        g.updated_at = now();
        tx.execute(
            "UPDATE maps SET graph=?2,cursor=?3 WHERE id=?1",
            params![id, serde_json::to_string(&g)?, next],
        )?;
        tx.commit()?;
        self.emit(&g, if delta < 0 { "undo" } else { "redo" });
        Ok(g)
    }
    pub fn undo(&self, id: &str) -> Result<Graph> {
        self.travel(id, -1)
    }
    pub fn redo(&self, id: &str) -> Result<Graph> {
        self.travel(id, 1)
    }
    pub fn recommend(&self, id: &str) -> Result<Vec<Node>> {
        let g = self.get_map(id)?;
        let done: HashSet<_> = g
            .nodes
            .iter()
            .filter(|n| matches!(n.status, Status::Mastered | Status::Skipped))
            .map(|n| n.id.as_str())
            .collect();
        Ok(g.nodes
            .iter()
            .filter(|n| {
                !done.contains(n.id.as_str())
                    && g.edges
                        .iter()
                        .filter(|e| e.source == n.id && e.kind != EdgeKind::Related)
                        .all(|e| done.contains(e.target.as_str()))
            })
            .cloned()
            .collect())
    }
    pub fn export_outline(&self, id: &str, format: &str) -> Result<String> {
        let g = self.get_map(id)?;
        match format {
            "json" => Ok(serde_json::to_string_pretty(&g)?),
            "mermaid" => {
                let mut s = String::from("flowchart TD\n");
                for n in &g.nodes {
                    s.push_str(&format!(
                        "  n_{}[\"{}\"]\n",
                        n.id,
                        n.title
                            .replace('&', "&amp;")
                            .replace('"', "&quot;")
                            .replace('<', "&lt;")
                            .replace('>', "&gt;")
                            .replace('\n', " ")
                    ));
                }
                for e in &g.edges {
                    s.push_str(&format!(
                        "  n_{} {}|{:?}| n_{}\n",
                        e.source,
                        if e.kind == EdgeKind::Related {
                            "-.->"
                        } else {
                            "-->"
                        },
                        e.kind,
                        e.target
                    ));
                }
                Ok(s)
            }
            "markdown" => {
                let mut s = format!("# {}\n\nRoot: [{}](#{})\n\n", g.title, g.root_id, g.root_id);
                for n in &g.nodes {
                    s.push_str(&format!(
                        "<a id=\"{}\"></a>\n## {}\n\n{}\n\n{}\n\n",
                        n.id, n.title, n.summary, n.explanation
                    ));
                    if !n.notes.is_empty() {
                        s.push_str(&format!("### Notes\n\n{}\n\n", n.notes));
                    }
                    for e in g.edges.iter().filter(|e| e.source == n.id) {
                        let target = g.nodes.iter().find(|n| n.id == e.target).unwrap();
                        s.push_str(&format!(
                            "- {:?}: [{}](#{}) — {}\n",
                            e.kind, target.title, target.id, e.reason
                        ));
                    }
                    s.push('\n');
                }
                Ok(s)
            }
            _ => bail!("unsupported export format: {format}"),
        }
    }
    pub fn seed_demo(&self) -> Result<Graph> {
        if let Ok(g) = self.get_map("pid-control") {
            return Ok(g);
        }
        // Concurrent callers may both observe an empty database before import.
        self.import_graph(demo())
            .or_else(|error| self.get_map("pid-control").map_err(|_| error))
    }
}
fn demo() -> Graph {
    let concepts=[
 ("pid","PID control","Combine proportional, integral, and derivative feedback.","## The controller\n\nFor tracking error **e(t) = r(t) − y(t)**:\n\n`u(t) = Kp e(t) + Ki ∫e(t)dt + Kd de(t)/dt`\n\nStart with a plant model, check stability, tune gradually, and validate against disturbances and actuator limits."),
 ("feedback","Negative feedback","Measure output and correct its error.","## Closed loop\n\nA sensor measures output `y`; compare it to the setpoint `r`. Negative feedback pushes the error toward zero. Check the sign: reversing it can make the loop unstable."),
 ("error","Tracking error","The difference between desired and measured output.","`e = r − y`. Keep units consistent. A temperature error is in degrees; a motor speed error is in revolutions per minute. Noise and measurement delay affect this signal."),
 ("plant","Plant model","Describe the process being controlled.","A plant turns actuator input into measured output. For a thermal system a useful first approximation is `τ dy/dt + y = K u`. Identify gain, time constant, and delay from a safe step experiment."),
 ("proportional","Proportional action","React to current error.","`uP = Kp e`. Larger gain often speeds the response but may increase overshoot. Proportional control alone can leave steady state error when a constant disturbance is present."),
 ("integral","Integral action","Accumulate persistent error.","`uI = Ki ∫ e dt`. Integration can remove steady state offset. Its stored state must be handled carefully during saturation or manual control."),
 ("derivative","Derivative action","Respond to the rate of change.","`uD = Kd de/dt`. Derivative action adds damping but amplifies high frequency noise. Often differentiate the measurement rather than the setpoint to avoid derivative kick."),
 ("calculus","Derivatives and integrals","Understand rates and accumulated quantities.","The derivative is instantaneous rate of change. The integral accumulates area over time. A constant error makes an integral grow linearly; an abrupt step has a very large ideal derivative."),
 ("algebra","Algebra and units","Manipulate equations and check dimensions.","Solve linear equations, understand ratios, and label units. A control gain must convert the units of its input into the units of actuator output. Dimensional checks catch many implementation errors."),
 ("dynamics","First order dynamics","Understand inertia and time constants.","For a first order step response, after one time constant the output covers about 63% of its final change. Delay adds phase lag and limits how aggressively a loop can be controlled."),
 ("laplace","Laplace transform","Represent linear differential equations algebraically.","With zero initial conditions, differentiation becomes multiplication by `s`. The plant `τ dy/dt + y = K u` becomes `G(s) = K/(τs+1)`. Track assumptions when moving between domains."),
 ("transfer","Transfer functions","Relate linear system input and output.","`G(s) = Y(s)/U(s)`. A feedback system has closed loop transfer `G C / (1 + G C)` for unity negative feedback. Poles determine natural response and stability."),
 ("stability","Closed loop stability","Keep the response bounded and convergent.","A continuous linear closed loop is asymptotically stable when all poles lie in the open left half plane. Delays, excessive gain, and sampling can destabilize a seemingly simple loop."),
 ("step","Step response metrics","Measure rise time, overshoot, and settling.","Apply a small safe change in setpoint. Record rise time, peak overshoot, settling time, and final offset. Compare both tracking and disturbance rejection; one metric alone is insufficient."),
 ("tuning","Practical PID tuning","Tune using measured evidence.","1. Verify sensor and actuator direction.\n2. Start with integral and derivative disabled.\n3. Increase proportional action carefully.\n4. Add integral to remove offset.\n5. Add filtered derivative if damping is needed.\n6. Test disturbances, limits, and multiple operating points."),
 ("sampling","Discrete time sampling","Choose and maintain a controller update period.","Use a fixed `dt` much smaller than important plant time scales. In a simple implementation `I += Ki * e * dt` and `D = Kd * (e - e_prev) / dt`. Watch jitter and delays."),
 ("noise","Measurement noise","Distinguish useful dynamics from sensor variation.","Sensor readings contain noise, quantization, and sometimes bias. Filtering reduces noise but introduces delay. Validate using logged measurements rather than assuming every fluctuation is real."),
 ("filter","Derivative filtering","Limit high frequency amplification.","Use a low pass filtered derivative, for example a first order filter on the measured rate. Select the filter time constant relative to sampling and plant bandwidth. Excessive filtering reduces useful damping."),
 ("saturation","Actuator saturation","Respect physical output limits.","A heater cannot supply negative heat and a motor drive has voltage and current limits. Clamp the final actuator command to its permitted range. The controller model should account for these limits."),
 ("anti-windup","Integral anti-windup","Prevent accumulation while output is constrained.","When output saturates, the integral can continue growing and cause slow recovery. Conditional integration or back calculation can keep the internal integral consistent with actual actuator output."),
 ("validation","Simulation and validation","Test robustness before deployment.","Simulate setpoint changes, disturbances, sensor noise, delays, and saturation. Then test on the real plant within safe bounds. Log setpoint, output, error, actuator command, and integral state."),
 ];
    let nodes = concepts
        .into_iter()
        .map(|(id, title, summary, explanation)| Node {
            id: id.into(),
            title: title.into(),
            summary: summary.into(),
            explanation: explanation.into(),
            status: if id == "algebra" {
                Status::Mastered
            } else if id == "feedback" {
                Status::Learning
            } else {
                Status::NotUnderstood
            },
            notes: String::new(),
            collapsed: false,
        })
        .collect();
    let dependencies = [
        ("pid", "proportional"),
        ("pid", "integral"),
        ("pid", "derivative"),
        ("pid", "tuning"),
        ("pid", "validation"),
        ("feedback", "error"),
        ("feedback", "plant"),
        ("error", "algebra"),
        ("plant", "dynamics"),
        ("proportional", "feedback"),
        ("integral", "feedback"),
        ("integral", "calculus"),
        ("derivative", "feedback"),
        ("derivative", "calculus"),
        ("derivative", "filter"),
        ("calculus", "algebra"),
        ("dynamics", "calculus"),
        ("laplace", "calculus"),
        ("transfer", "laplace"),
        ("transfer", "plant"),
        ("stability", "transfer"),
        ("step", "dynamics"),
        ("tuning", "stability"),
        ("tuning", "step"),
        ("tuning", "anti-windup"),
        ("sampling", "calculus"),
        ("filter", "noise"),
        ("filter", "sampling"),
        ("anti-windup", "integral"),
        ("anti-windup", "saturation"),
        ("validation", "sampling"),
        ("validation", "step"),
    ];
    let mut edges: Vec<Edge> = dependencies
        .into_iter()
        .enumerate()
        .map(|(i, (source, target))| Edge {
            id: format!("dep-{i}"),
            source: source.into(),
            target: target.into(),
            kind: EdgeKind::Required,
            reason: format!(
                "Understand {} before studying {}.",
                target.replace('-', " "),
                source.replace('-', " ")
            ),
        })
        .collect();
    edges.push(Edge {
        id: "rec-tuning-noise".into(),
        source: "tuning".into(),
        target: "noise".into(),
        kind: EdgeKind::Recommended,
        reason: "Noisy measurements can mislead tuning decisions.".into(),
    });
    edges.push(Edge {
        id: "related-pi".into(),
        source: "proportional".into(),
        target: "integral".into(),
        kind: EdgeKind::Related,
        reason: "P and I are commonly combined as a PI controller.".into(),
    });
    Graph {
        id: "pid-control".into(),
        title: "Understanding PID Control".into(),
        root_id: "pid".into(),
        version: 1,
        nodes,
        edges,
        updated_at: now(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn memory() -> Store {
        Store::open(":memory:").unwrap()
    }
    fn rename(g: &Graph, title: &str) -> Patch {
        Patch {
            map_id: g.id.clone(),
            expected_version: g.version,
            operations: vec![Operation::RenameMap {
                title: title.into(),
            }],
        }
    }
    #[test]
    fn atomic_validation_and_conflict() {
        let s = memory();
        let g = s.seed_demo().unwrap();
        let mut rx = s.subscribe();
        let mut patch = rename(&g, "should roll back");
        patch.operations.push(Operation::DeleteNode {
            node_id: g.root_id.clone(),
        });
        assert!(s.apply_graph_patch(patch).is_err());
        assert_eq!(s.get_map(&g.id).unwrap(), g);
        assert!(rx.try_recv().is_err());
        let changed = s.apply_graph_patch(rename(&g, "new name")).unwrap();
        assert!(s
            .apply_graph_patch(rename(&g, "stale"))
            .unwrap_err()
            .to_string()
            .contains("version conflict"));
        assert_eq!(changed.version, g.version + 1);
        let event = rx.try_recv().unwrap();
        assert_eq!(event.version, changed.version);
        assert_eq!(s.get_map(&event.map_id).unwrap().title, "new name");
    }
    #[test]
    fn references_cycles_and_duplicates() {
        let s = memory();
        let g = s.seed_demo().unwrap();
        let mut bad = g.clone();
        bad.id = "different".into();
        bad.nodes.push(bad.nodes[0].clone());
        assert!(s.import_graph(bad).is_err());
        for (kind, target) in [
            (EdgeKind::Required, "pid"),
            (EdgeKind::Recommended, "pid"),
            (EdgeKind::Related, "missing"),
        ] {
            let edge = Edge {
                id: "bad-edge".into(),
                source: "algebra".into(),
                target: target.into(),
                kind,
                reason: String::new(),
            };
            let p = Patch {
                map_id: g.id.clone(),
                expected_version: g.version,
                operations: vec![Operation::UpsertEdge { edge }],
            };
            assert!(s.apply_graph_patch(p).is_err());
        }
        let edge = Edge {
            id: "related-cycle".into(),
            source: "algebra".into(),
            target: "pid".into(),
            kind: EdgeKind::Related,
            reason: String::new(),
        };
        assert!(s
            .apply_graph_patch(Patch {
                map_id: g.id.clone(),
                expected_version: g.version,
                operations: vec![Operation::UpsertEdge { edge }]
            })
            .is_ok());
    }
    #[test]
    fn undo_redo_monotonic_and_branch() {
        let s = memory();
        let g = s.seed_demo().unwrap();
        let g2 = s.apply_graph_patch(rename(&g, "two")).unwrap();
        let g3 = s.undo(&g.id).unwrap();
        assert_eq!(g3.title, g.title);
        assert!(g3.version > g2.version);
        let g4 = s.redo(&g.id).unwrap();
        assert_eq!(g4.title, "two");
        assert!(g4.version > g3.version);
        let g5 = s.undo(&g.id).unwrap();
        s.apply_graph_patch(rename(&g5, "branch")).unwrap();
        assert!(s.redo(&g.id).is_err());
    }
    #[test]
    fn persistence_and_deleted_restore() {
        let path = std::env::temp_dir().join(format!("atlas-{}.db", uuid::Uuid::new_v4()));
        let g;
        {
            let s = Store::open(&path).unwrap();
            let initial = s.seed_demo().unwrap();
            g = s.apply_graph_patch(rename(&initial, "persisted")).unwrap();
            s.delete_map(&g.id, g.version).unwrap();
            assert!(s.get_map(&g.id).is_err());
        }
        {
            let s = Store::open(&path).unwrap();
            let restored = s.restore_deleted_map().unwrap();
            assert_eq!(restored.title, "persisted");
            assert!(restored.version > g.version);
            let undone = s.undo(&g.id).unwrap();
            assert_eq!(undone.title, "Understanding PID Control");
            assert!(undone.version > restored.version);
            assert_eq!(s.redo(&g.id).unwrap().title, "persisted");
            assert!(s.restore_deleted_map().is_err());
        }
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn shared_exports_and_ready_recommendations() {
        let s = memory();
        let g = s.seed_demo().unwrap();
        assert!(g.nodes.len() >= 18);
        assert_eq!(s.seed_demo().unwrap(), g);
        let md = s.export_outline(&g.id, "markdown").unwrap();
        assert_eq!(md.matches("## Algebra and units\n").count(), 1);
        assert!(md.matches("](#algebra)").count() > 1);
        assert!(s
            .export_outline(&g.id, "mermaid")
            .unwrap()
            .contains("flowchart TD"));
        let exported: Graph =
            serde_json::from_str(&s.export_outline(&g.id, "json").unwrap()).unwrap();
        assert_eq!(exported, g);
        let rec = s.recommend(&g.id).unwrap();
        assert!(rec.iter().any(|n| n.id == "calculus"));
        assert!(!rec.iter().any(|n| n.id == "pid" || n.id == "algebra"));
    }
    #[test]
    fn mermaid_ids_stay_stable_when_nodes_reorder() {
        let s = memory();
        let original = s.seed_demo().unwrap();
        let original_export = s.export_outline(&original.id, "mermaid").unwrap();
        let mut reordered = original.clone();
        reordered.id = "reordered-map".into();
        reordered.nodes.reverse();
        s.import_graph(reordered).unwrap();
        let reordered_export = s.export_outline("reordered-map", "mermaid").unwrap();
        for node in &original.nodes {
            let prefix = format!("  n_{}[", node.id);
            let line = original_export
                .lines()
                .find(|line| line.starts_with(&prefix))
                .unwrap();
            assert!(reordered_export.lines().any(|candidate| candidate == line));
        }
        assert!(original_export.contains("n_pid -->|Required| n_proportional"));
        assert!(original_export.contains("n_anti-windup["));
        assert!(!original_export.contains("  n0["));
    }
    #[test]
    fn invalid_or_missing_deletions_roll_back_atomically() {
        let s = memory();
        let g = s.seed_demo().unwrap();
        let mut receiver = s.subscribe();
        for id in ["missing", "invalid/id", ""] {
            for operation in [
                Operation::DeleteNode { node_id: id.into() },
                Operation::DeleteEdge { edge_id: id.into() },
            ] {
                let mut patch = rename(&g, "must roll back");
                patch.operations.push(operation);
                assert!(s.apply_graph_patch(patch).is_err());
                assert_eq!(s.get_map(&g.id).unwrap(), g);
                assert!(receiver.try_recv().is_err());
            }
        }
        assert!(s.undo(&g.id).is_err());
        let edge = g.edges[0].id.clone();
        let next = s
            .apply_graph_patch(Patch {
                map_id: g.id.clone(),
                expected_version: g.version,
                operations: vec![Operation::DeleteEdge {
                    edge_id: edge.clone(),
                }],
            })
            .unwrap();
        assert!(!next.edges.iter().any(|e| e.id == edge));
    }
    #[test]
    fn rejects_invalid_ids_self_edges_and_statuses() {
        let s = memory();
        let g = s.seed_demo().unwrap();
        let mut invalid = g.clone();
        invalid.id = "invalid/map".into();
        assert!(s.import_graph(invalid).is_err());
        let mut invalid = g.clone();
        invalid.id = "self-edge-map".into();
        invalid.edges.push(Edge {
            id: "self".into(),
            source: "pid".into(),
            target: "pid".into(),
            kind: EdgeKind::Related,
            reason: String::new(),
        });
        assert!(s.import_graph(invalid).is_err());
        let mut value = serde_json::to_value(&g.nodes[0]).unwrap();
        value["status"] = serde_json::json!("invalid");
        assert!(serde_json::from_value::<Node>(value).is_err());
    }
    #[test]
    fn concurrent_clones_enforce_optimistic_version() {
        let s = memory();
        let g = s.seed_demo().unwrap();
        let patch = rename(&g, "concurrent");
        let other = s.clone();
        let second = patch.clone();
        let worker = std::thread::spawn(move || other.apply_graph_patch(second));
        let first = s.apply_graph_patch(patch);
        let second = worker.join().unwrap();
        assert_ne!(first.is_ok(), second.is_ok());
        assert_eq!(s.get_map(&g.id).unwrap().version, g.version + 1);
    }
    #[test]
    fn deleting_root_atomically_retargets_and_removes_incident_edges() {
        let s = memory();
        let g = s.seed_demo().unwrap();
        let updated = s
            .apply_graph_patch(Patch {
                map_id: g.id.clone(),
                expected_version: g.version,
                operations: vec![
                    Operation::DeleteNode {
                        node_id: "pid".into(),
                    },
                    Operation::SetRoot {
                        node_id: "tuning".into(),
                    },
                ],
            })
            .unwrap();
        assert_eq!(updated.root_id, "tuning");
        assert!(updated
            .edges
            .iter()
            .all(|e| e.source != "pid" && e.target != "pid"));
        let restored = s.undo(&g.id).unwrap();
        assert_eq!(restored.nodes, g.nodes);
        assert_eq!(restored.edges, g.edges);
    }
}
