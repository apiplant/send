//! Signalling server for apiplant-send, plus an optional static host for the app.
//!
//! Everything is REST: peers exchange SDP and ICE candidates through per-session
//! mailboxes drained by a long poll. That is a handful of messages per transfer,
//! so it costs less than keeping a socket per peer alive.

mod code;
mod state;

use std::sync::Arc;
use std::time::{Duration, Instant};

use ntex::time::sleep;
use ntex::http::{header, Method};
use ntex::web::{self, HttpResponse};
use serde::Deserialize;
use serde_json::{json, Value};

use state::{FileMeta, Registry, Role, SignalError};

/// How long a poll waits for a message before returning empty-handed.
const POLL_WAIT: Duration = Duration::from_secs(20);
const POLL_TICK: Duration = Duration::from_millis(80);

#[derive(Deserialize)]
struct RoleQuery {
    role: Role,
}

/// Whether peers must encrypt file bytes end to end on top of the data
/// channel's own DTLS. `required` is the default; `optional` lets the sender
/// choose per transfer; `off` forbids it, for deployments that would rather
/// spend nothing on it over a network they already trust.
#[derive(Clone, Copy, PartialEq, Eq)]
enum EncryptionPolicy {
    Required,
    Optional,
    Off,
}

impl EncryptionPolicy {
    fn from_env(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "required" => Ok(EncryptionPolicy::Required),
            "optional" => Ok(EncryptionPolicy::Optional),
            "off" | "disabled" | "none" => Ok(EncryptionPolicy::Off),
            other => Err(format!(
                "APIPLANT_SEND_ENCRYPTION must be required, optional or off (got {other:?})"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            EncryptionPolicy::Required => "required",
            EncryptionPolicy::Optional => "optional",
            EncryptionPolicy::Off => "off",
        }
    }
}

fn cors(mut res: HttpResponse) -> HttpResponse {
    // The app may be deployed statically against a remote signalling server.
    let headers = res.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        header::HeaderValue::from_static("content-type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        header::HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
    );
    res
}

async fn preflight() -> HttpResponse {
    cors(HttpResponse::NoContent().finish())
}

async fn health(registry: web::types::State<Arc<Registry>>) -> HttpResponse {
    cors(HttpResponse::Ok().json(&json!({ "ok": true, "sessions": registry.len() })))
}

/// The app reads this once at startup; both peers therefore reach the same
/// conclusion about encryption before they ever talk to each other.
async fn config(policy: web::types::State<EncryptionPolicy>) -> HttpResponse {
    cors(HttpResponse::Ok().json(&json!({ "encryption": policy.as_str() })))
}

/// ICE servers for the browsers' `RTCPeerConnection`. Always includes a STUN
/// server; a TURN relay is appended from `APIPLANT_SEND_TURN` (a JSON array of
/// `RTCIceServer` objects, or a single object) when the deployment sets one.
/// Peers on symmetric NATs — most mobile networks — can only connect through a
/// relay, so without this they silently fail to establish a data channel.
async fn turn(servers: web::types::State<Arc<Value>>) -> HttpResponse {
    cors(HttpResponse::Ok().json(&json!({
        "iceServers": servers.get_ref().as_ref(),
        "relay": has_relay(&servers),
    })))
}

/// Whether the list carries a real TURN relay, not just STUN. The frontend
/// warns the user when it does not.
fn has_relay(servers: &Value) -> bool {
    let is_turn = |url: &Value| {
        url.as_str()
            .map(|s| s.starts_with("turn:") || s.starts_with("turns:"))
            .unwrap_or(false)
    };
    servers.as_array().into_iter().flatten().any(|entry| match entry.get("urls") {
        Some(Value::String(_)) => is_turn(&entry["urls"]),
        Some(Value::Array(urls)) => urls.iter().any(is_turn),
        _ => false,
    })
}

fn ice_servers_from_env() -> Value {
    let mut servers = vec![json!({ "urls": "stun:stun.l.google.com:19302" })];
    match std::env::var("APIPLANT_SEND_TURN") {
        Ok(raw) if !raw.trim().is_empty() => match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Array(items)) => servers.extend(items),
            Ok(object @ Value::Object(_)) => servers.push(object),
            Ok(_) => eprintln!("APIPLANT_SEND_TURN must be a JSON array or object; ignoring it"),
            Err(err) => eprintln!("APIPLANT_SEND_TURN is not valid JSON ({err}); ignoring it"),
        },
        _ => {}
    }
    Value::Array(servers)
}

/// Sender registers an upload offer and gets back a nameplate. The browser
/// appends the two secret words to form the code the user actually shares.
async fn create_session(
    registry: web::types::State<Arc<Registry>>,
    body: web::types::Json<FileMeta>,
) -> HttpResponse {
    let meta = body.into_inner();
    if meta.name.is_empty() || meta.sha256.len() != 64 {
        return cors(bad_request("name and a 64-character sha256 are required"));
    }
    let nameplate = registry.create(meta);
    cors(HttpResponse::Ok().json(&json!({ "nameplate": nameplate })))
}

/// Receiver looks up what it is about to download, before any peer connection.
async fn get_session(
    registry: web::types::State<Arc<Registry>>,
    path: web::types::Path<String>,
) -> HttpResponse {
    let code = code::normalize(&path.into_inner());
    match registry.info(&code) {
        Some(info) => cors(HttpResponse::Ok().json(&json!({
            "nameplate": code,
            "meta": info.meta,
            "claimed": info.claimed,
        }))),
        None => cors(not_found()),
    }
}

/// Hands one SDP/ICE message to the other side of the session.
async fn post_signal(
    registry: web::types::State<Arc<Registry>>,
    path: web::types::Path<String>,
    query: web::types::Query<RoleQuery>,
    body: web::types::Json<Value>,
) -> HttpResponse {
    let code = code::normalize(&path.into_inner());
    match registry.post(&code, query.role, body.into_inner()) {
        Ok(()) => cors(HttpResponse::Ok().json(&json!({ "ok": true }))),
        Err(SignalError::UnknownCode) => cors(not_found()),
        Err(SignalError::TooManyMessages) => cors(
            HttpResponse::TooManyRequests().json(&json!({ "error": "signal inbox is full" })),
        ),
    }
}

/// Long poll: returns as soon as this role has mail, or empty after POLL_WAIT.
async fn poll_signals(
    registry: web::types::State<Arc<Registry>>,
    path: web::types::Path<String>,
    query: web::types::Query<RoleQuery>,
) -> HttpResponse {
    let code = code::normalize(&path.into_inner());
    let deadline = Instant::now() + POLL_WAIT;
    loop {
        // The lock is never held across the await below.
        match registry.drain(&code, query.role) {
            None => return cors(not_found()),
            Some(messages) if !messages.is_empty() => {
                return cors(HttpResponse::Ok().json(&json!({ "messages": messages })));
            }
            Some(_) => {}
        }
        if Instant::now() >= deadline {
            return cors(HttpResponse::Ok().json(&json!({ "messages": [] })));
        }
        sleep(POLL_TICK).await;
    }
}

/// Called when a transfer finishes or is cancelled, so the code stops working.
async fn delete_session(
    registry: web::types::State<Arc<Registry>>,
    path: web::types::Path<String>,
) -> HttpResponse {
    let code = code::normalize(&path.into_inner());
    if registry.remove(&code) {
        cors(HttpResponse::Ok().json(&json!({ "ok": true })))
    } else {
        cors(not_found())
    }
}

fn not_found() -> HttpResponse {
    HttpResponse::NotFound().json(&json!({ "error": "no such code" }))
}

fn bad_request(message: &str) -> HttpResponse {
    HttpResponse::BadRequest().json(&json!({ "error": message }))
}

#[ntex::main]
async fn main() -> std::io::Result<()> {
    let addr = std::env::var("APIPLANT_SEND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let static_dir = std::env::var("APIPLANT_SEND_STATIC").unwrap_or_else(|_| "./static".to_string());
    let ttl = std::env::var("APIPLANT_SEND_TTL")
        .ok()
        .and_then(|v| v.parse().ok())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(3600));

    let policy = match EncryptionPolicy::from_env(
        &std::env::var("APIPLANT_SEND_ENCRYPTION").unwrap_or_else(|_| "required".to_string()),
    ) {
        Ok(policy) => policy,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    let registry = Arc::new(Registry::new(ttl));
    let ice_servers = Arc::new(ice_servers_from_env());
    let extra_ice = ice_servers.as_array().map_or(0, |a| a.len().saturating_sub(1));
    let serve_static = std::path::Path::new(&static_dir).is_dir();

    println!("apiplant-send signalling server on http://{addr}");
    println!("  encryption: {}", policy.as_str());
    println!(
        "  turn: {}",
        if extra_ice > 0 {
            format!("{extra_ice} relay entr{} from APIPLANT_SEND_TURN", if extra_ice == 1 { "y" } else { "ies" })
        } else {
            "(none - STUN only; peers behind symmetric NAT will fail to connect)".to_string()
        }
    );
    println!(
        "  static: {}",
        if serve_static {
            static_dir.as_str()
        } else {
            "(none - run the Vite dev server or build into ./static)"
        }
    );

    web::server(move || {
        let registry = registry.clone();
        let ice_servers = ice_servers.clone();
        let static_dir = static_dir.clone();
        let app = web::App::new()
            .state(registry)
            .state(policy)
            .state(ice_servers)
            .service(
                web::scope("/api")
                    .route("/health", web::get().to(health))
                    .route("/config", web::get().to(config))
                    .route("/turn", web::get().to(turn))
                    .route("/turn", web::method(Method::OPTIONS).to(preflight))
                    .route("/sessions", web::post().to(create_session))
                    .route("/sessions", web::method(Method::OPTIONS).to(preflight))
                    .route("/sessions/{code}", web::get().to(get_session))
                    .route("/sessions/{code}", web::delete().to(delete_session))
                    .route(
                        "/sessions/{code}",
                        web::method(Method::OPTIONS).to(preflight),
                    )
                    .route("/sessions/{code}/signal", web::post().to(post_signal))
                    .route(
                        "/sessions/{code}/signal",
                        web::method(Method::OPTIONS).to(preflight),
                    )
                    .route("/sessions/{code}/poll", web::get().to(poll_signals))
                    .route(
                        "/sessions/{code}/poll",
                        web::method(Method::OPTIONS).to(preflight),
                    ),
            );

        if serve_static {
            app.service(ntex_files::Files::new("/", &static_dir).index_file("index.html"))
        } else {
            app
        }
    })
    .bind(&addr)?
    .run()
    .await
}
