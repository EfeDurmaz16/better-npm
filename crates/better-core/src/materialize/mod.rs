// crates/better-core/src/materialize/mod.rs

pub mod strict;

pub use strict::{
    StrictPkg, StrictPkgFile, StrictLayoutPlan, StrictLayoutStats,
    PhantomDep,
    plan_strict_layout, materialise_strict_plan, detect_phantom_deps,
};
