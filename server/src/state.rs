//! In-memory session registry. The server only ever holds file *metadata* and
//! opaque SDP/ICE blobs — file bytes go peer to peer and never touch this.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::code;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileMeta {
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub mime: String,
    /// Lowercase hex SHA-256 of the whole file, computed by the sender.
    pub sha256: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Sender,
    Receiver,
}

impl Role {
    fn peer(self) -> Role {
        match self {
            Role::Sender => Role::Receiver,
            Role::Receiver => Role::Sender,
        }
    }
}

struct Session {
    meta: FileMeta,
    /// Set the moment a receiver first signals on this code. A code is good for
    /// one download: once taken, a second receiver is turned away at lookup
    /// rather than left to collide with the first on the shared mailbox.
    claimed: bool,
    /// Messages waiting to be picked up, per recipient role.
    sender_inbox: Vec<Value>,
    receiver_inbox: Vec<Value>,
    touched: Instant,
}

pub struct SessionInfo {
    pub meta: FileMeta,
    pub claimed: bool,
}

pub struct Registry {
    sessions: Mutex<HashMap<String, Session>>,
    ttl: Duration,
}

pub enum SignalError {
    UnknownCode,
    TooManyMessages,
}

impl Registry {
    pub fn new(ttl: Duration) -> Self {
        Registry {
            sessions: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    /// Registers an upload offer and returns the nameplate the sender shares.
    /// The words the user reads out are appended by the browser and never
    /// reach this function.
    pub fn create(&self, meta: FileMeta) -> String {
        let mut sessions = self.sessions.lock().unwrap();
        self.sweep(&mut sessions);

        let taken: HashSet<&String> = sessions.keys().collect();
        let code = code::allocate(&taken);

        sessions.insert(
            code.clone(),
            Session {
                meta,
                claimed: false,
                sender_inbox: Vec::new(),
                receiver_inbox: Vec::new(),
                touched: Instant::now(),
            },
        );
        code
    }

    pub fn info(&self, code: &str) -> Option<SessionInfo> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(code)?;
        session.touched = Instant::now();
        Some(SessionInfo {
            meta: session.meta.clone(),
            claimed: session.claimed,
        })
    }

    /// Queues a message for the *other* side of the session.
    pub fn post(&self, code: &str, from: Role, message: Value) -> Result<(), SignalError> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(code).ok_or(SignalError::UnknownCode)?;
        // The first byte a receiver sends here is what marks the code as spent.
        if from == Role::Receiver {
            session.claimed = true;
        }
        let inbox = match from.peer() {
            Role::Sender => &mut session.sender_inbox,
            Role::Receiver => &mut session.receiver_inbox,
        };
        // A peer that never polls must not be able to grow the box unbounded.
        if inbox.len() >= 256 {
            return Err(SignalError::TooManyMessages);
        }
        inbox.push(message);
        session.touched = Instant::now();
        Ok(())
    }

    /// Drains everything addressed to `role`. `None` means the code is gone.
    pub fn drain(&self, code: &str, role: Role) -> Option<Vec<Value>> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(code)?;
        session.touched = Instant::now();
        let inbox = match role {
            Role::Sender => &mut session.sender_inbox,
            Role::Receiver => &mut session.receiver_inbox,
        };
        Some(std::mem::take(inbox))
    }

    pub fn remove(&self, code: &str) -> bool {
        self.sessions.lock().unwrap().remove(code).is_some()
    }

    pub fn len(&self) -> usize {
        let mut sessions = self.sessions.lock().unwrap();
        self.sweep(&mut sessions);
        sessions.len()
    }

    fn sweep(&self, sessions: &mut HashMap<String, Session>) {
        let ttl = self.ttl;
        sessions.retain(|_, s| s.touched.elapsed() < ttl);
    }
}
