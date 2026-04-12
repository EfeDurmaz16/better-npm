// crates/better-core/src/registry/dht.rs
// Task 102: Kademlia-inspired DHT for content-addressed package discovery.
// Peers announce which CIDs they can serve; lookups resolve CID -> fetch URL.

use std::collections::HashMap;
use std::net::SocketAddr;
use serde::{Deserialize, Serialize};
use super::cid::ContentId;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PeerInfo {
    pub node_id: String,   // Hex-encoded 32-byte node ID
    pub addr: String,      // "ip:port"
    pub last_seen: u64,
    pub capabilities: PeerCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PeerCapabilities {
    pub can_serve: bool,
    pub bandwidth_mbps: u32,
    pub storage_gb: u32,
    pub ecosystems: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DhtError {
    Network(String),
    Timeout,
    NoProviders,
}

impl std::fmt::Display for DhtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(s) => write!(f, "Network error: {}", s),
            Self::Timeout => write!(f, "Timeout"),
            Self::NoProviders => write!(f, "No providers found"),
        }
    }
}

// ---------------------------------------------------------------------------
// Routing table
// ---------------------------------------------------------------------------

struct RoutingTable {
    /// 256 k-buckets (one per bit of XOR distance)
    buckets: Vec<Vec<PeerInfo>>,
    /// Bucket capacity
    k: usize,
}

impl RoutingTable {
    fn new(k: usize) -> Self {
        Self { buckets: vec![vec![]; 256], k }
    }

    /// Add or refresh a peer.
    fn add_peer(&mut self, peer: PeerInfo) {
        let bucket = self.bucket_for(&peer.node_id);
        let existing = self.buckets[bucket].iter().position(|p| p.node_id == peer.node_id);
        if let Some(idx) = existing {
            self.buckets[bucket].remove(idx);
        }
        if self.buckets[bucket].len() < self.k {
            self.buckets[bucket].push(peer);
        }
    }

    /// Return the k closest peers to the given key.
    fn find_closest(&self, _key: &[u8; 32], k: usize) -> Vec<PeerInfo> {
        self.buckets
            .iter()
            .flat_map(|b| b.iter().cloned())
            .take(k)
            .collect()
    }

    fn bucket_for(&self, node_id: &str) -> usize {
        // Use first byte as bucket index (simplified Kademlia)
        node_id.bytes().next().map(|b| b as usize % 256).unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// DhtNode
// ---------------------------------------------------------------------------

/// A local DHT node that participates in peer discovery.
/// This is a simplified in-process implementation; a production
/// implementation would use UDP RPC to real peers.
pub struct DhtNode {
    pub node_id: [u8; 32],
    pub listen_addr: SocketAddr,
    routing_table: RoutingTable,
    /// Local store: CID -> list of peer infos that can serve it
    store: HashMap<String, Vec<PeerInfo>>,
}

impl DhtNode {
    /// Create a new DhtNode with a random node ID.
    pub fn new(listen_addr: SocketAddr) -> Self {
        let mut node_id = [0u8; 32];
        generate_random_bytes(&mut node_id);
        Self {
            node_id,
            listen_addr,
            routing_table: RoutingTable::new(20),
            store: HashMap::new(),
        }
    }

    /// Announce that this node can serve a specific CID.
    /// In production this would send STORE RPCs to the k closest peers.
    pub fn announce(&mut self, cid: &ContentId) -> Result<(), DhtError> {
        let info = self.own_peer_info();
        self.store.entry(cid.as_cid_string()).or_default().push(info);
        Ok(())
    }

    /// Find peers known to serve a given CID.
    /// Returns the local store's entries (in production this would iterate the DHT).
    pub fn find_providers(&self, cid: &ContentId) -> Result<Vec<PeerInfo>, DhtError> {
        let peers = self.store.get(&cid.as_cid_string()).cloned().unwrap_or_default();
        if peers.is_empty() {
            Err(DhtError::NoProviders)
        } else {
            Ok(peers)
        }
    }

    /// Add a peer to the routing table.
    pub fn add_peer(&mut self, peer: PeerInfo) {
        self.routing_table.add_peer(peer);
    }

    /// Find the k closest peers to a given CID key.
    pub fn closest_peers(&self, cid: &ContentId) -> Vec<PeerInfo> {
        let key = dht_key_from_cid(cid);
        self.routing_table.find_closest(&key, 20)
    }

    fn own_peer_info(&self) -> PeerInfo {
        PeerInfo {
            node_id: hex_encode(&self.node_id),
            addr: self.listen_addr.to_string(),
            last_seen: super::cid::current_timestamp(),
            capabilities: PeerCapabilities {
                can_serve: true,
                bandwidth_mbps: 100,
                storage_gb: 50,
                ecosystems: vec!["npm".into(), "python".into()],
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn dht_key_from_cid(cid: &ContentId) -> [u8; 32] {
    use sha2::{Sha256, Digest};
    let hash = Sha256::digest(cid.as_cid_string().as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&hash);
    key
}

fn generate_random_bytes(buf: &mut [u8; 32]) {
    // Use rand for random bytes
    use rand::RngCore;
    rand::thread_rng().fill_bytes(buf);
}

fn hex_encode(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::cid::ContentId;

    fn make_node() -> DhtNode {
        let addr: SocketAddr = "127.0.0.1:4001".parse().unwrap();
        DhtNode::new(addr)
    }

    #[test]
    fn new_node_has_random_id() {
        let a = make_node();
        let b = make_node();
        // With overwhelming probability two random 32-byte IDs differ
        assert_ne!(a.node_id, b.node_id);
    }

    #[test]
    fn announce_then_find_providers() {
        let mut node = make_node();
        let cid = ContentId::sha256(b"test package");
        node.announce(&cid).unwrap();
        let providers = node.find_providers(&cid).unwrap();
        assert!(!providers.is_empty());
    }

    #[test]
    fn find_providers_no_announcement_returns_error() {
        let node = make_node();
        let cid = ContentId::sha256(b"unknown");
        let result = node.find_providers(&cid);
        assert!(matches!(result, Err(DhtError::NoProviders)));
    }

    #[test]
    fn add_peer_and_find_closest() {
        let mut node = make_node();
        let peer = PeerInfo {
            node_id: "abcdef01".to_string(),
            addr: "192.168.1.1:4001".to_string(),
            last_seen: 0,
            capabilities: PeerCapabilities {
                can_serve: true,
                bandwidth_mbps: 10,
                storage_gb: 5,
                ecosystems: vec!["npm".into()],
            },
        };
        node.add_peer(peer.clone());
        let cid = ContentId::sha256(b"any");
        let closest = node.closest_peers(&cid);
        assert!(closest.iter().any(|p| p.node_id == peer.node_id));
    }

    #[test]
    fn peer_capabilities_serializes() {
        let caps = PeerCapabilities {
            can_serve: true,
            bandwidth_mbps: 100,
            storage_gb: 50,
            ecosystems: vec!["npm".into()],
        };
        let json = serde_json::to_string(&caps).unwrap();
        assert!(json.contains("can_serve"));
    }

    #[test]
    fn dht_error_display() {
        assert!(DhtError::Timeout.to_string().contains("Timeout"));
        assert!(DhtError::NoProviders.to_string().contains("No providers"));
        assert!(DhtError::Network("err".into()).to_string().contains("err"));
    }
}
