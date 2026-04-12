// crates/better-core/src/registry/mod.rs
// Task 102-107: Decentralized + federated registry support.
//
// Legacy npm registry operations (from registry.rs) are in `legacy`.
// New content-addressed / federation modules are alongside it.

pub mod legacy;
pub mod cid;
pub mod dht;
pub mod federation;
pub mod index;
pub mod signing_types;
pub mod unified;

// Re-export legacy types so existing code continues to work
pub use legacy::{
    RegistryEntry, RegistryConfig, load_registry_config, resolve_registry,
    registry_add, registry_list, registry_remove, registry_rotate, RegistryChain,
};

// New CAS / federation types
pub use cid::{ContentId, HashAlgorithm, PublishReceipt, PublishStatus, PublishTarget};
pub use federation::{
    FederatedResolver, FederationError,
    RegistryConfig as FederatedConfig, RegistryEntry as FederatedEntry, RegistryType,
};
pub use index::{PackageIndex, PackageIndexEntry, PublisherInfo, VersionEntry};
pub use unified::{EntryType, SearchEntry, SearchSource, UnifiedSearchResult};
