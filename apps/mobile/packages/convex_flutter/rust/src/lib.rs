mod frb_generated;
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(debug_assertions)]
use android_logger::Config;
use async_once_cell::OnceCell;
use convex::{
    ConvexClient,
    ConvexClientBuilder,
    FunctionResult,
    Value, // Convex client and result types
    WebSocketState as ConvexWebSocketState,
};
use flutter_rust_bridge::{frb, DartFnFuture};
use futures::{
    channel::oneshot::{self, Sender},
    pin_mut, select_biased, FutureExt, StreamExt,
};
use log::debug; // Logging for debugging purposes
#[cfg(debug_assertions)]
use log::LevelFilter;
use parking_lot::Mutex;
use base64::Engine;
use serde::Deserialize;

// Custom error type for Convex client operations, exposed to Dart.
#[derive(Debug, thiserror::Error)]
#[frb]
pub enum ClientError {
    /// An internal error within the mobile Convex client.
    #[error("InternalError: {msg}")]
    InternalError { msg: String },
    /// An application-specific error from a remote Convex backend function.
    #[error("ConvexError: {data}")]
    ConvexError { data: String },
    /// An unexpected server-side error from a remote Convex function.
    #[error("ServerError: {msg}")]
    ServerError { msg: String },
}

impl From<anyhow::Error> for ClientError {
    fn from(value: anyhow::Error) -> Self {
        Self::InternalError {
            msg: value.to_string(),
        }
    }
}

/// JWT claims structure for extracting expiration time.
#[derive(Deserialize)]
struct JwtClaims {
    exp: u64,
}

/// Decodes a JWT token and extracts the expiration timestamp.
/// Returns None if the token is malformed or doesn't contain an exp claim.
fn decode_jwt_expiry(token: &str) -> Option<u64> {
    // JWT format: header.payload.signature
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }

    // Decode payload (second part) using URL-safe base64
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .ok()?;

    let claims: JwtClaims = serde_json::from_slice(&payload).ok()?;
    Some(claims.exp)
}

/// WebSocket connection state exposed to Flutter/Dart.
///
/// This enum represents the current state of the WebSocket connection
/// to the Convex backend, allowing real-time connection monitoring.
#[derive(Debug, Clone)]
#[frb]
pub enum WebSocketConnectionState {
    /// The WebSocket is open and connected to the Convex backend.
    Connected,
    /// The WebSocket is closed and is connecting or reconnecting.
    Connecting,
}

impl From<ConvexWebSocketState> for WebSocketConnectionState {
    fn from(state: ConvexWebSocketState) -> Self {
        match state {
            ConvexWebSocketState::Connected => WebSocketConnectionState::Connected,
            ConvexWebSocketState::Connecting => WebSocketConnectionState::Connecting,
        }
    }
}

/// Trait defining the interface for handling subscription updates.
// Not directly exposed to Dart, used internally by subscribers.
pub trait QuerySubscriber: Send + Sync {
    fn on_update(&self, value: String); // Called when a new update is received
    fn on_error(&self, message: String, value: Option<String>); // Called on error with optional value
}

/// Adapter struct to implement QuerySubscriber using Dart callbacks.
pub struct CallbackSubscriber {
    on_update: Box<dyn Fn(String) + Send + Sync>, // Callback for updates
    on_error: Box<dyn Fn(String, Option<String>) + Send + Sync>, // Callback for errors
}

impl QuerySubscriber for CallbackSubscriber {
    fn on_update(&self, value: String) {
        (self.on_update)(value);
    }

    fn on_error(&self, message: String, value: Option<String>) {
        (self.on_error)(message, value);
    }
}

/// Opaque type for Dart, representing a subscription handle with cancellation.
#[frb(opaque)]
pub struct SubscriptionHandle {
    cancel_sender: Arc<Mutex<Option<Sender<()>>>>, // Sender to cancel the subscription
}

impl SubscriptionHandle {
    fn new(cancel_sender: Sender<()>) -> Self {
        SubscriptionHandle {
            cancel_sender: Arc::new(Mutex::new(Some(cancel_sender))),
        }
    }

    /// Cancels the subscription by sending a cancellation signal.
    #[frb(sync)]
    pub fn cancel(&self) {
        if let Some(sender) = self.cancel_sender.lock().take() {
            sender.send(()).unwrap();
        }
    }
}

/// Opaque type for Dart, representing an auth session handle with lifecycle management.
/// Used to control the token refresh loop and check authentication state.
#[frb(opaque)]
pub struct AuthHandle {
    cancel_sender: Arc<Mutex<Option<Sender<()>>>>,
    is_authenticated: Arc<AtomicBool>,
}

impl AuthHandle {
    fn new(cancel_sender: Sender<()>, is_authenticated: Arc<AtomicBool>) -> Self {
        AuthHandle {
            cancel_sender: Arc::new(Mutex::new(Some(cancel_sender))),
            is_authenticated,
        }
    }

    /// Disposes the auth session, stopping the token refresh loop and clearing authentication.
    #[frb(sync)]
    pub fn dispose(&self) {
        if let Some(sender) = self.cancel_sender.lock().take() {
            let _ = sender.send(());
        }
    }

    /// Returns whether the user is currently authenticated.
    #[frb(sync)]
    pub fn is_authenticated(&self) -> bool {
        self.is_authenticated.load(Ordering::SeqCst)
    }
}

/// Adapter for Dart functions as subscribers, handling async callbacks.
pub struct CallbackSubscriberDartFn {
    on_update: Box<dyn Fn(String) -> DartFnFuture<()> + Send + Sync>, // Async update callback
    on_error: Box<dyn Fn(String, Option<String>) -> DartFnFuture<()> + Send + Sync>, // Async error callback
}

impl QuerySubscriber for CallbackSubscriberDartFn {
    fn on_update(&self, value: String) {
        let future = (self.on_update)(value);
        tokio::spawn(async move {
            let _ = future.await; // Await the future, ignoring the result
        });
    }

    fn on_error(&self, message: String, value: Option<String>) {
        let future = (self.on_error)(message, value);
        tokio::spawn(async move {
            let _ = future.await;
        });
    }
}

/// Main Convex client struct, opaque to Dart, managing connections and operations.
#[frb(opaque)]
pub struct MobileConvexClient {
    deployment_url: String,         // URL of the Convex deployment
    client_id: String,              // Client ID for authentication
    client: OnceCell<ConvexClient>, // Lazy-initialized Convex client
    rt: tokio::runtime::Runtime,    // Tokio runtime for async operations
    // Channel sender for WebSocket state change notifications
    state_change_sender: Arc<Mutex<Option<tokio::sync::mpsc::Sender<ConvexWebSocketState>>>>,
    // Monotonic auth-session generation. Every `set_auth_with_refresh` arm and
    // every direct `set_auth` bumps it; a refresh loop only touches client auth
    // while its own generation is still current. This orders the
    // cancel-vs-rearm handoff: a dying loop's late `set_auth(None)` (or a slow
    // in-flight fetch resolving after a successor armed) can never clobber the
    // successor's freshly applied token.
    auth_generation: Arc<AtomicU64>,
}

impl MobileConvexClient {
    /// Creates a new MobileConvexClient instance with the given deployment URL and client ID.
    #[frb(sync)]
    pub fn new(deployment_url: String, client_id: String) -> MobileConvexClient {
        #[cfg(debug_assertions)]
        android_logger::init_once(Config::default().with_max_level(LevelFilter::Error));
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        MobileConvexClient {
            deployment_url,
            client_id,
            client: OnceCell::new(),
            rt,
            state_change_sender: Arc::new(Mutex::new(None)),
            auth_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Sets up WebSocket connection state change listener.
    ///
    /// Must be called BEFORE any queries/mutations to capture all state changes.
    /// The callback will be invoked whenever the WebSocket transitions between
    /// Connected and Connecting states.
    ///
    /// # Arguments
    ///
    /// * `on_state_change` - Async callback invoked when connection state changes
    ///
    /// # Example
    ///
    /// ```dart
    /// await client.onWebsocketStateChange(
    ///   onStateChange: (state) async {
    ///     print('Connection state: ${state.name}');
    ///   },
    /// );
    /// ```
    #[frb]
    pub async fn on_websocket_state_change(
        &self,
        on_state_change: impl Fn(WebSocketConnectionState) -> DartFnFuture<()> + Send + Sync + 'static,
    ) -> Result<(), ClientError> {
        println!("RUST: on_websocket_state_change() called");

        // Create tokio mpsc channel for receiving state changes from convex client
        let (state_tx, mut state_rx) = tokio::sync::mpsc::channel::<ConvexWebSocketState>(10);
        println!("RUST: Created mpsc channel for state changes");

        // Store sender for use when initializing the client
        {
            let mut sender = self.state_change_sender.lock();
            *sender = Some(state_tx);
            println!("RUST: Stored state_tx in state_change_sender");
        }

        // Spawn task to listen for state changes and call Dart callback
        let on_state_change = Arc::new(on_state_change);
        println!("RUST: Spawning listener task for state changes");
        self.rt.spawn(async move {
            println!("RUST: Listener task started, waiting for state changes");
            while let Some(state) = state_rx.recv().await {
                println!("RUST: Received state change from channel: {:?}", state);
                let dart_state = WebSocketConnectionState::from(state);
                println!("RUST: Converted to Dart state: {:?}", dart_state);
                let callback = on_state_change.clone();
                let future = (callback)(dart_state);
                println!("RUST: Calling Dart callback");
                let _ = future.await;
                println!("RUST: Dart callback completed");
            }
            println!("RUST: Listener task exiting (channel closed)");
        });

        println!("RUST: on_websocket_state_change() returning");
        Ok(())
    }

    /// Retrieves or initializes a connected Convex client.
    async fn connected_client(&self) -> anyhow::Result<ConvexClient> {
        let url = self.deployment_url.clone();
        let state_sender = self.state_change_sender.lock().clone();

        println!("RUST: connected_client() called with sender: {:?}", state_sender.is_some());

        self.client
            .get_or_try_init(async {
                let client_id = self.client_id.to_owned();

                // Build client directly without spawning a task
                // This ensures callback is registered BEFORE connection starts
                println!("RUST: Building ConvexClient directly (no task spawn)");
                let mut builder = ConvexClientBuilder::new(url.as_str())
                    .with_client_id(&client_id);

                // Register state change callback BEFORE building
                if let Some(sender) = state_sender {
                    println!("RUST: Registering state change callback with builder");
                    builder = builder.with_on_state_change(sender);
                } else {
                    println!("RUST WARNING: No sender available - state changes will not be emitted");
                }

                println!("RUST: Calling builder.build() - connection will start now");
                let result = builder.build().await;
                match &result {
                    Ok(_) => println!("RUST: ConvexClient built successfully"),
                    Err(e) => println!("RUST ERROR: Failed to build ConvexClient: {:?}", e),
                }
                result
            })
            .await
            .map(|client_ref| client_ref.clone())
    }

    /// Executes a query on the Convex backend.
    #[frb]
    pub async fn query(
        &self,
        name: String,
        args: HashMap<String, String>,
    ) -> Result<String, ClientError> {
        let mut client = self.connected_client().await?;
        debug!("got the client");
        let result = client.query(name.as_str(), parse_json_args(args)).await?;
        debug!("got the result");
        handle_direct_function_result(result)
    }

    /// Subscribes to real-time updates from a Convex query.
    #[frb]
    pub async fn subscribe(
        &self,
        name: String,
        args: HashMap<String, String>,
        on_update: impl Fn(String) -> DartFnFuture<()> + Send + Sync + 'static,
        on_error: impl Fn(String, Option<String>) -> DartFnFuture<()> + Send + Sync + 'static,
    ) -> Result<SubscriptionHandle, ClientError> {
        let subscriber = Arc::new(CallbackSubscriberDartFn {
            on_update: Box::new(on_update),
            on_error: Box::new(on_error),
        });
        self.internal_subscribe(name, args, subscriber)
            .await
            .map_err(Into::into)
    }

    /// Internal method for subscription logic.
    async fn internal_subscribe(
        &self,
        name: String,
        args: HashMap<String, String>,
        subscriber: Arc<dyn QuerySubscriber>,
    ) -> anyhow::Result<SubscriptionHandle> {
        let mut client = self.connected_client().await?;
        debug!("New subscription");
        let mut subscription = client
            .subscribe(name.as_str(), parse_json_args(args))
            .await?;
        let (cancel_sender, cancel_receiver) = oneshot::channel::<()>();
        self.rt.spawn(async move {
            let cancel_fut = cancel_receiver.fuse();
            pin_mut!(cancel_fut);
            loop {
                select_biased! {
                    new_val = subscription.next().fuse() => {
                        let new_val = match new_val {
                            Some(val) => val,
                            None => {
                                log::warn!("Subscription stream ended for {}", &name);
                                break;
                            }
                        };
                        match new_val {
                            FunctionResult::Value(value) => {
                                debug!("Updating with {value:?}");
                                subscriber.on_update(serde_json::to_string(
                                    &serde_json::Value::from(value),
                                ).unwrap());
                            }
                            FunctionResult::ErrorMessage(message) => {
                                subscriber.on_error(message, None);
                            }
                            FunctionResult::ConvexError(error) => subscriber.on_error(
                                error.message,
                                Some(serde_json::ser::to_string(
                                    &serde_json::Value::from(error.data),
                                ).unwrap()),
                            ),
                        }
                    }
                    _ = cancel_fut => {
                        break;
                    }
                }
            }
            debug!("Subscription canceled");
        });
        Ok(SubscriptionHandle::new(cancel_sender))
    }

    /// Executes a mutation on the Convex backend.
    #[frb]
    pub async fn mutation(
        &self,
        name: String,
        args: HashMap<String, String>,
    ) -> Result<String, ClientError> {
        let result = self.internal_mutation(name, args).await?;
        handle_direct_function_result(result)
    }

    /// Internal method for mutation logic.
    async fn internal_mutation(
        &self,
        name: String,
        args: HashMap<String, String>,
    ) -> anyhow::Result<FunctionResult> {
        let mut client = self.connected_client().await?;
        self.rt
            .spawn(async move { client.mutation(&name, parse_json_args(args)).await })
            .await?
    }

    /// Executes an action on the Convex backend.
    #[frb]
    pub async fn action(
        &self,
        name: String,
        args: HashMap<String, String>,
    ) -> Result<String, ClientError> {
        debug!("Running action: {}", name);
        let result = self.internal_action(name, args).await?;
        debug!("Got action result: {:?}", result);
        handle_direct_function_result(result)
    }

    /// Internal method for action logic.
    async fn internal_action(
        &self,
        name: String,
        args: HashMap<String, String>,
    ) -> anyhow::Result<FunctionResult> {
        let mut client = self.connected_client().await?;
        debug!("Running action: {}", name);
        self.rt
            .spawn(async move { client.action(&name, parse_json_args(args)).await })
            .await?
    }

    /// Sets authentication token for the client.
    #[frb]
    pub async fn set_auth(&self, token: Option<String>) -> Result<(), ClientError> {
        Ok(self.internal_set_auth(token).await?)
    }

    /// Internal method for setting authentication.
    async fn internal_set_auth(&self, token: Option<String>) -> anyhow::Result<()> {
        // A direct set_auth/clear is authoritative: supersede any live refresh
        // loop so its late writes are suppressed rather than racing this one.
        self.auth_generation.fetch_add(1, Ordering::SeqCst);
        let mut client = self.connected_client().await?;
        self.rt
            .spawn(async move { client.set_auth(token).await })
            .await
            .map_err(|e| e.into())
    }

    /// Sets authentication with automatic token refresh.
    ///
    /// The `fetch_token` callback is called:
    /// - Immediately to get the initial token
    /// - Automatically when the token is about to expire (60 seconds before expiry)
    /// - On a bounded backoff schedule after a failed fetch (`None`), instead of
    ///   permanently stopping the refresh loop
    ///
    /// The `on_auth_change` callback fires `true` after EVERY successful local
    /// token application (a per-refresh heartbeat, not a once-ever signal), and
    /// `false` when auth is actually cleared: cancellation while this session is
    /// still current, or fetch failures outlasting the applied token's expiry.
    /// A transient fetch failure while the applied token is still valid keeps
    /// auth in place and retries — it no longer deauthenticates the session.
    ///
    /// Refresh loops are generation-ordered: arming a new session (or calling
    /// `set_auth` directly) supersedes older loops, whose late clears/applies
    /// are suppressed so a dying loop can never clobber its successor's auth.
    ///
    /// Returns an AuthHandle that can be used to dispose the auth session.
    #[frb]
    pub async fn set_auth_with_refresh(
        &self,
        fetch_token: impl Fn() -> DartFnFuture<Option<String>> + Send + Sync + 'static,
        on_auth_change: impl Fn(bool) -> DartFnFuture<()> + Send + Sync + 'static,
    ) -> Result<AuthHandle, ClientError> {
        let is_authenticated = Arc::new(AtomicBool::new(false));
        let (cancel_sender, cancel_receiver) = oneshot::channel::<()>();

        let client = self.connected_client().await?;
        let is_auth_clone = is_authenticated.clone();

        let fetch_token = Arc::new(fetch_token);
        let on_auth_change = Arc::new(on_auth_change);

        // Buffer time before token expiry to trigger refresh (60 seconds)
        const REFRESH_BUFFER_SECS: u64 = 60;
        // Minimum refresh interval to prevent tight loops on errors
        const MIN_REFRESH_INTERVAL_SECS: u64 = 5;
        // Default refresh interval when JWT can't be decoded (5 minutes)
        const DEFAULT_REFRESH_INTERVAL_SECS: u64 = 300;
        // Backoff schedule between retries after the fetcher returns None.
        // Capped, never terminal: the loop keeps retrying until cancelled or
        // superseded (a signed-out user is handled by Dart disposing the handle).
        const FETCH_RETRY_BACKOFF_SECS: [u64; 5] = [5, 10, 20, 40, 60];

        // Claim a new auth generation; any loop with an older generation is now
        // superseded and must not touch client auth again.
        let generation = self.auth_generation.clone();
        let my_generation = generation.fetch_add(1, Ordering::SeqCst) + 1;

        // Spawn the token refresh loop
        self.rt.spawn(async move {
            let mut cancel_fut = cancel_receiver.fuse();
            let mut was_authenticated = false;
            let mut consecutive_fetch_failures: usize = 0;
            // Expiry of the most recently APPLIED token — governs whether a
            // fetch failure must clear auth (token dead) or may keep it (still
            // valid) while retrying.
            let mut applied_token_exp: Option<u64> = None;

            let superseded = || generation.load(Ordering::SeqCst) != my_generation;

            loop {
                if superseded() {
                    debug!("Auth refresh loop superseded before fetch; exiting");
                    break;
                }

                // Fetch token from Dart
                let fetch_token_clone = fetch_token.clone();
                let token_future = (fetch_token_clone)();

                let token_result = select_biased! {
                    _ = cancel_fut => {
                        // Cancelled - clear auth and exit, unless a successor
                        // session already owns client auth.
                        debug!("Auth refresh cancelled");
                        if !superseded() {
                            let mut client = client.clone();
                            client.set_auth(None).await;
                            is_auth_clone.store(false, Ordering::SeqCst);
                            if was_authenticated {
                                let on_auth_change_clone = on_auth_change.clone();
                                let future = (on_auth_change_clone)(false);
                                let _ = future.await;
                            }
                        }
                        break;
                    }
                    token = token_future.fuse() => token,
                };

                let now_secs = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs();

                match token_result {
                    Some(token) => {
                        // A successor may have armed while our fetch was in
                        // flight; applying now would overwrite its (newer)
                        // token with our (older) one.
                        if superseded() {
                            debug!("Auth refresh loop superseded during fetch; discarding token");
                            break;
                        }

                        // Set the token
                        let mut client = client.clone();
                        client.set_auth(Some(token.clone())).await;
                        consecutive_fetch_failures = 0;
                        applied_token_exp = decode_jwt_expiry(&token);

                        // Per-refresh heartbeat: notify Dart on EVERY successful
                        // apply, not only the first. Dart uses this as the
                        // "token applied this cycle" signal; without it the
                        // ~hourly silent refresh is invisible client-side.
                        was_authenticated = true;
                        is_auth_clone.store(true, Ordering::SeqCst);
                        let on_auth_change_clone = on_auth_change.clone();
                        let future = (on_auth_change_clone)(true);
                        tokio::spawn(async move {
                            let _ = future.await;
                        });

                        // Decode expiry and schedule next refresh
                        let sleep_duration = if let Some(exp) = applied_token_exp {
                            let refresh_at = exp.saturating_sub(REFRESH_BUFFER_SECS);
                            if refresh_at > now_secs {
                                Duration::from_secs(refresh_at - now_secs)
                            } else {
                                // Token already expired or about to, refresh immediately
                                Duration::from_secs(MIN_REFRESH_INTERVAL_SECS)
                            }
                        } else {
                            // Can't decode JWT, use default refresh interval
                            debug!("Could not decode JWT expiry, using default refresh interval");
                            Duration::from_secs(DEFAULT_REFRESH_INTERVAL_SECS)
                        };

                        debug!("Next token refresh in {:?}", sleep_duration);

                        // Sleep until refresh time or cancellation
                        let sleep_fut = tokio::time::sleep(sleep_duration).fuse();
                        pin_mut!(sleep_fut);
                        select_biased! {
                            _ = cancel_fut => {
                                debug!("Auth refresh cancelled during sleep");
                                if !superseded() {
                                    let mut client = client.clone();
                                    client.set_auth(None).await;
                                    is_auth_clone.store(false, Ordering::SeqCst);
                                    if was_authenticated {
                                        let on_auth_change_clone = on_auth_change.clone();
                                        let future = (on_auth_change_clone)(false);
                                        let _ = future.await;
                                    }
                                }
                                break;
                            }
                            _ = sleep_fut => {
                                // Time to refresh, continue loop
                            }
                        }
                    }
                    None => {
                        // Fetch failed (or no user). Do NOT stop the loop: a
                        // single transient Firebase failure at the hourly
                        // boundary used to deauthenticate the session forever.
                        consecutive_fetch_failures += 1;

                        // Keep the applied token while it can still be valid;
                        // only clear auth once it has actually expired.
                        let applied_token_dead =
                            applied_token_exp.map_or(true, |exp| now_secs >= exp);
                        if was_authenticated && applied_token_dead {
                            if superseded() {
                                break;
                            }
                            debug!("Token fetch failing past expiry, clearing auth");
                            let mut client = client.clone();
                            client.set_auth(None).await;
                            was_authenticated = false;
                            applied_token_exp = None;
                            is_auth_clone.store(false, Ordering::SeqCst);
                            let on_auth_change_clone = on_auth_change.clone();
                            let future = (on_auth_change_clone)(false);
                            tokio::spawn(async move {
                                let _ = future.await;
                            });
                        }

                        let backoff_idx = (consecutive_fetch_failures - 1)
                            .min(FETCH_RETRY_BACKOFF_SECS.len() - 1);
                        let retry_delay =
                            Duration::from_secs(FETCH_RETRY_BACKOFF_SECS[backoff_idx]);
                        debug!(
                            "Token fetch returned None (failure #{}), retrying in {:?}",
                            consecutive_fetch_failures, retry_delay
                        );

                        let sleep_fut = tokio::time::sleep(retry_delay).fuse();
                        pin_mut!(sleep_fut);
                        select_biased! {
                            _ = cancel_fut => {
                                debug!("Auth refresh cancelled during fetch retry backoff");
                                if !superseded() {
                                    let mut client = client.clone();
                                    client.set_auth(None).await;
                                    is_auth_clone.store(false, Ordering::SeqCst);
                                    if was_authenticated {
                                        let on_auth_change_clone = on_auth_change.clone();
                                        let future = (on_auth_change_clone)(false);
                                        let _ = future.await;
                                    }
                                }
                                break;
                            }
                            _ = sleep_fut => {
                                // Time to retry the fetch, continue loop
                            }
                        }
                    }
                }
            }

            debug!("Auth refresh loop ended");
        });

        Ok(AuthHandle::new(cancel_sender, is_authenticated))
    }
}

/// Utility function to parse HashMap arguments into Convex Value format.
fn parse_json_args(raw_args: HashMap<String, String>) -> BTreeMap<String, Value> {
    raw_args
        .into_iter()
        .map(|(k, v)| {
            (
                k,
                Value::try_from(
                    serde_json::from_str::<serde_json::Value>(&v)
                        .expect("Invalid JSON data from FFI"),
                )
                .expect("Invalid Convex data from FFI"),
            )
        })
        .collect()
}

/// Utility function to handle and serialize FunctionResult into a string or error.
fn handle_direct_function_result(result: FunctionResult) -> Result<String, ClientError> {
    match result {
        FunctionResult::Value(v) => serde_json::to_string(&serde_json::Value::from(v))
            .map_err(|e| ClientError::InternalError { msg: e.to_string() }),
        FunctionResult::ConvexError(e) => Err(ClientError::ConvexError {
            data: serde_json::ser::to_string(&serde_json::Value::from(e.data)).unwrap(),
        }),
        FunctionResult::ErrorMessage(msg) => Err(ClientError::ServerError { msg }),
    }
}
