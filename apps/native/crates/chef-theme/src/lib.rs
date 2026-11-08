//! Theme của bản native (BLUEPRINT_RUST §6.1). Token sinh từ apps/ui/src/app/styles/tokens.css
//! bằng scripts/gen-native-theme.mjs; không sửa tay generated.rs.

pub mod generated;

pub use generated::{Rgba, dark, light, shared};
