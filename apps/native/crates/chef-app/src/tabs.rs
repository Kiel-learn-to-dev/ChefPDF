//! Pure document-tab model for R2.15.
//!
//! Integration contract: each document, viewer, and edit session belongs to one `TabId`.
//! When a tab becomes inactive, integration must evict that tab's page bitmaps from cache.
//! This module only owns tab metadata and selection; it does not host viewers or caches yet.

#![allow(dead_code)]

use std::path::PathBuf;

/// Stable, monotonically allocated identity. A closed tab's ID is never reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TabId(u64);

impl TabId {
    pub fn get(self) -> u64 {
        self.0
    }
}

/// Metadata associated with one open document tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tab {
    id: TabId,
    title: String,
    path: Option<PathBuf>,
    dirty: bool,
}

impl Tab {
    pub fn id(&self) -> TabId {
        self.id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn path(&self) -> Option<&PathBuf> {
        self.path.as_ref()
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }
}

/// The tab model has exhausted its 64-bit ID space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TabIdExhausted;

/// Ordered tabs and the currently selected tab.
#[derive(Debug)]
pub struct Tabs {
    items: Vec<Tab>,
    active: Option<TabId>,
    /// Zero is the exhausted sentinel; allocated IDs start at one and are never recycled.
    next_id: u64,
}

impl Tabs {
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            active: None,
            next_id: 1,
        }
    }

    /// Add a tab and activate it. `path` may be absent for an unsaved document.
    pub fn open(
        &mut self,
        title: impl Into<String>,
        path: Option<PathBuf>,
    ) -> Result<TabId, TabIdExhausted> {
        if self.next_id == 0 {
            return Err(TabIdExhausted);
        }
        let id = TabId(self.next_id);
        self.next_id = self.next_id.checked_add(1).unwrap_or(0);
        self.items.push(Tab {
            id,
            title: title.into(),
            path,
            dirty: false,
        });
        self.active = Some(id);
        Ok(id)
    }

    pub fn tabs(&self) -> &[Tab] {
        &self.items
    }

    pub fn get(&self, id: TabId) -> Option<&Tab> {
        self.items.iter().find(|tab| tab.id == id)
    }

    pub fn active_id(&self) -> Option<TabId> {
        self.active
    }

    pub fn active(&self) -> Option<&Tab> {
        self.active.and_then(|id| self.get(id))
    }

    /// Activate an existing tab; return false without changing state for an unknown ID.
    pub fn activate(&mut self, id: TabId) -> bool {
        if self.items.iter().any(|tab| tab.id == id) {
            self.active = Some(id);
            true
        } else {
            false
        }
    }

    /// Cycle forward with wraparound (Ctrl+Tab behavior).
    pub fn cycle_next(&mut self) -> Option<TabId> {
        self.cycle(1)
    }

    /// Cycle backward with wraparound (Ctrl+Shift+Tab behavior).
    pub fn cycle_previous(&mut self) -> Option<TabId> {
        self.cycle(-1)
    }

    fn cycle(&mut self, direction: isize) -> Option<TabId> {
        if self.items.is_empty() {
            self.active = None;
            return None;
        }
        let current = self
            .active
            .and_then(|active| self.items.iter().position(|tab| tab.id == active))
            .unwrap_or(0);
        let len = self.items.len() as isize;
        let next = (current as isize + direction).rem_euclid(len) as usize;
        let id = self.items[next].id;
        self.active = Some(id);
        Some(id)
    }

    /// Close a tab. Closing an inactive tab preserves selection. Closing the active tab selects
    /// the tab now occupying its index, or the previous final tab when it was at the end.
    pub fn close(&mut self, id: TabId) -> Option<Tab> {
        let index = self.items.iter().position(|tab| tab.id == id)?;
        let was_active = self.active == Some(id);
        let closed = self.items.remove(index);
        if was_active {
            self.active = if self.items.is_empty() {
                None
            } else {
                Some(self.items[index.min(self.items.len() - 1)].id)
            };
        }
        Some(closed)
    }

    pub fn set_title(&mut self, id: TabId, title: impl Into<String>) -> bool {
        let Some(tab) = self.items.iter_mut().find(|tab| tab.id == id) else {
            return false;
        };
        tab.title = title.into();
        true
    }

    pub fn set_path(&mut self, id: TabId, path: Option<PathBuf>) -> bool {
        let Some(tab) = self.items.iter_mut().find(|tab| tab.id == id) else {
            return false;
        };
        tab.path = path;
        true
    }

    pub fn set_dirty(&mut self, id: TabId, dirty: bool) -> bool {
        let Some(tab) = self.items.iter_mut().find(|tab| tab.id == id) else {
            return false;
        };
        tab.dirty = dirty;
        true
    }
}

impl Default for Tabs {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::Tabs;
    use std::path::PathBuf;

    #[test]
    fn three_open_tabs_have_stable_ids_and_new_tab_becomes_active() {
        let mut tabs = Tabs::new();
        let first = tabs
            .open("one.pdf", Some(PathBuf::from("/docs/one.pdf")))
            .unwrap();
        let second = tabs
            .open("two.pdf", Some(PathBuf::from("/docs/two.pdf")))
            .unwrap();
        let third = tabs.open("Untitled", None).unwrap();

        assert_eq!(tabs.tabs().len(), 3);
        assert_eq!(tabs.active_id(), Some(third));
        assert_ne!(first, second);
        assert_ne!(second, third);
        assert_eq!(
            tabs.get(first).unwrap().path(),
            Some(&PathBuf::from("/docs/one.pdf"))
        );
        assert!(tabs.set_dirty(first, true));
        assert!(tabs.get(first).unwrap().is_dirty());
    }

    #[test]
    fn activation_and_cycles_wrap_in_both_directions() {
        let mut tabs = Tabs::new();
        let first = tabs.open("one", None).unwrap();
        let second = tabs.open("two", None).unwrap();
        let third = tabs.open("three", None).unwrap();

        assert!(tabs.activate(first));
        assert_eq!(tabs.cycle_next(), Some(second));
        assert_eq!(tabs.cycle_next(), Some(third));
        assert_eq!(tabs.cycle_next(), Some(first));
        assert_eq!(tabs.cycle_previous(), Some(third));
    }

    #[test]
    fn close_preserves_inactive_selection_and_selects_neighbor_for_active() {
        let mut tabs = Tabs::new();
        let first = tabs.open("one", None).unwrap();
        let second = tabs.open("two", None).unwrap();
        let third = tabs.open("three", None).unwrap();

        assert!(tabs.close(third).is_some());
        assert_eq!(tabs.active_id(), Some(second));
        assert!(tabs.close(first).is_some());
        assert_eq!(tabs.active_id(), Some(second));
        let last = tabs.open("four", None).unwrap();
        assert_eq!(tabs.active_id(), Some(last));
        assert!(tabs.activate(second));
        assert!(tabs.close(second).is_some());
        assert_eq!(tabs.active_id(), Some(last));
        assert!(tabs.close(last).is_some());
        assert_eq!(tabs.active_id(), None);
        assert_eq!(tabs.cycle_next(), None);
    }
}
