//! Pure Rust model for side-by-side viewing (TASKS_RUST R4.08, feature B8).
//!
//! Coordinates a shared byte-budgeted LRU page bitmap cache across all open `Viewer` tabs and an
//! optional `ComparePane`, alongside split-pane selection/lifecycle reconciliation and page-number
//! input parsing.

use crate::cache::LruCache;

/// Composite cache key partitioning page indices by viewer instance (`owner`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SharedCacheKey {
    pub owner: u64,
    pub page: usize,
}

/// Shared LRU bitmap cache across multiple document panes/tabs under one byte budget (R1.33).
///
/// Evicted values (from LRU replacement, owner eviction, or budget reduction) are buffered in
/// `pending_drops` so the GPUI UI thread can release GPU textures with `Window::drop_image`.
pub struct SharedPageCache<V> {
    cache: LruCache<SharedCacheKey, V>,
    next_owner: u64,
    pending_drops: Vec<V>,
}

impl<V> SharedPageCache<V> {
    pub fn new(budget_bytes: usize) -> Self {
        Self {
            cache: LruCache::new(budget_bytes),
            next_owner: 1,
            pending_drops: Vec::new(),
        }
    }

    pub fn allocate_owner(&mut self) -> u64 {
        let owner = self.next_owner;
        self.next_owner = self.next_owner.checked_add(1).unwrap_or(1);
        owner
    }

    pub fn budget(&self) -> usize {
        self.cache.budget()
    }

    pub fn set_budget(&mut self, budget_bytes: usize) {
        self.pending_drops
            .extend(self.cache.set_budget(budget_bytes));
    }

    pub fn total_bytes(&self) -> usize {
        self.cache.total_bytes()
    }

    pub fn total_len(&self) -> usize {
        self.cache.len()
    }

    /// Return whether pre-fetching a non-visible buffer page would still fit within budget.
    /// Avoiding buffer pre-renders when tight prevents eviction thrashing between two panes.
    pub fn can_prefetch(&self, estimated_bytes: usize) -> bool {
        self.cache.total_bytes().saturating_add(estimated_bytes) <= self.cache.budget()
    }

    pub fn owner_len(&self, owner: u64) -> usize {
        self.cache
            .entries_with_bytes()
            .filter(|(key, _, _)| key.owner == owner)
            .count()
    }

    pub fn owner_bytes(&self, owner: u64) -> usize {
        self.cache
            .entries_with_bytes()
            .filter(|(key, _, _)| key.owner == owner)
            .map(|(_, _, bytes)| bytes)
            .sum()
    }

    pub fn owner_pages(&self, owner: u64) -> Vec<usize> {
        self.cache
            .entries()
            .filter(|(key, _)| key.owner == owner)
            .map(|(key, _)| key.page)
            .collect()
    }

    pub fn owner_entries(&self, owner: u64) -> Vec<(usize, &V)> {
        self.cache
            .entries()
            .filter(|(key, _)| key.owner == owner)
            .map(|(key, value)| (key.page, value))
            .collect()
    }

    pub fn contains(&self, owner: u64, page: usize) -> bool {
        self.cache.contains(&SharedCacheKey { owner, page })
    }

    pub fn get(&mut self, owner: u64, page: usize) -> Option<&V> {
        self.cache.get(&SharedCacheKey { owner, page })
    }

    pub fn insert(&mut self, owner: u64, page: usize, value: V, bytes: usize) {
        let evicted = self
            .cache
            .insert(SharedCacheKey { owner, page }, value, bytes);
        self.pending_drops.extend(evicted);
    }

    pub fn remove(&mut self, owner: u64, page: usize) -> Option<V> {
        self.cache.remove(&SharedCacheKey { owner, page })
    }

    pub fn evict_owner(&mut self, owner: u64) {
        let keys: Vec<SharedCacheKey> = self
            .cache
            .entries()
            .filter(|(key, _)| key.owner == owner)
            .map(|(key, _)| *key)
            .collect();
        for key in keys {
            if let Some(value) = self.cache.remove(&key) {
                self.pending_drops.push(value);
            }
        }
    }

    pub fn take_drops(&mut self) -> Vec<V> {
        std::mem::take(&mut self.pending_drops)
    }
}

/// Result of reconciling the split pane target against the currently open document tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitReconcile {
    Closed,
    Keep(u64),
    Fallback(u64),
}

/// Pure host state for whether the secondary split pane is open and which tab it shows.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SplitState {
    open: bool,
    target_tab: Option<u64>,
}

impl SplitState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn target_tab(&self) -> Option<u64> {
        self.target_tab
    }

    pub fn open_for(&mut self, active_tab: u64) {
        self.open = true;
        self.target_tab = Some(active_tab);
    }

    pub fn toggle(&mut self, active_tab: Option<u64>) -> bool {
        if self.open {
            self.close_secondary();
            false
        } else if let Some(tab) = active_tab {
            self.open_for(tab);
            true
        } else {
            false
        }
    }

    pub fn close_secondary(&mut self) {
        self.open = false;
        self.target_tab = None;
    }

    pub fn select_tab(&mut self, tab_id: u64, open_tabs: &[u64]) -> bool {
        if !self.open || !open_tabs.contains(&tab_id) {
            return false;
        }
        self.target_tab = Some(tab_id);
        true
    }

    pub fn reconcile_tabs(&mut self, open_tabs: &[u64], active_tab: Option<u64>) -> SplitReconcile {
        if !self.open {
            return SplitReconcile::Closed;
        }
        let Some(active) = active_tab.filter(|id| open_tabs.contains(id)) else {
            self.close_secondary();
            return SplitReconcile::Closed;
        };
        if let Some(target) = self.target_tab
            && open_tabs.contains(&target)
        {
            return SplitReconcile::Keep(target);
        }
        self.target_tab = Some(active);
        SplitReconcile::Fallback(active)
    }
}

/// Parse a 1-based user page number input into a 0-based page index within `0..page_count`.
pub fn parse_page_input(text: &str, page_count: usize) -> Option<usize> {
    if page_count == 0 {
        return None;
    }
    let page = text.trim().parse::<usize>().ok()?;
    if (1..=page_count).contains(&page) {
        Some(page - 1)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{SharedPageCache, SplitReconcile, SplitState, parse_page_input};

    #[test]
    fn shared_cache_enforces_single_budget_across_two_owners_and_queues_drops() {
        let mut cache = SharedPageCache::new(250);
        let left = cache.allocate_owner();
        let right = cache.allocate_owner();
        assert_ne!(left, right);

        cache.insert(left, 0, "L0", 100);
        cache.insert(right, 0, "R0", 100);
        assert!(cache.take_drops().is_empty());
        assert_eq!(cache.total_bytes(), 200);
        assert_eq!(cache.owner_bytes(left), 100);
        assert_eq!(cache.owner_bytes(right), 100);

        // Touch L0 so R0 becomes the least recently used entry globally.
        assert_eq!(cache.get(left, 0), Some(&"L0"));
        cache.insert(right, 1, "R1", 100);

        assert_eq!(cache.take_drops(), vec!["R0"]);
        assert!(cache.total_bytes() <= cache.budget());
        assert!(cache.contains(left, 0));
        assert!(cache.contains(right, 1));
        assert!(!cache.contains(right, 0));
    }

    #[test]
    fn shared_cache_can_prefetch_respects_remaining_budget() {
        let mut cache = SharedPageCache::new(250);
        let owner = cache.allocate_owner();
        assert!(cache.can_prefetch(250));
        cache.insert(owner, 0, "P0", 150);
        assert!(cache.can_prefetch(100));
        assert!(!cache.can_prefetch(101));
    }

    #[test]
    fn shared_cache_evict_owner_leaves_other_owners_untouched() {
        let mut cache = SharedPageCache::new(1000);
        let left = cache.allocate_owner();
        let right = cache.allocate_owner();
        cache.insert(left, 0, "L0", 120);
        cache.insert(left, 1, "L1", 130);
        cache.insert(right, 0, "R0", 140);
        cache.insert(right, 1, "R1", 150);

        cache.evict_owner(right);
        let mut drops = cache.take_drops();
        drops.sort();
        assert_eq!(drops, vec!["R0", "R1"]);
        assert_eq!(cache.owner_len(right), 0);
        assert_eq!(cache.owner_bytes(right), 0);
        assert_eq!(cache.owner_len(left), 2);
        assert_eq!(cache.owner_bytes(left), 250);
        assert!(cache.contains(left, 0));
        assert!(cache.contains(left, 1));
    }

    #[test]
    fn shared_cache_keeps_same_page_index_distinct_per_owner() {
        let mut cache = SharedPageCache::new(500);
        let left = cache.allocate_owner();
        let right = cache.allocate_owner();
        cache.insert(left, 2, "left-page-3", 100);
        cache.insert(right, 2, "right-page-3", 100);

        assert_eq!(cache.total_len(), 2);
        assert_eq!(cache.get(left, 2), Some(&"left-page-3"));
        assert_eq!(cache.get(right, 2), Some(&"right-page-3"));
        assert_eq!(cache.owner_pages(left), vec![2]);
        assert_eq!(cache.owner_pages(right), vec![2]);
    }

    #[test]
    fn split_state_toggle_open_and_close() {
        let mut split = SplitState::new();
        assert!(!split.is_open());
        assert!(!split.toggle(None));
        assert!(!split.is_open());

        assert!(split.toggle(Some(1)));
        assert!(split.is_open());
        assert_eq!(split.target_tab(), Some(1));

        assert!(!split.toggle(Some(1)));
        assert!(!split.is_open());
        assert_eq!(split.target_tab(), None);

        split.open_for(3);
        assert!(split.is_open());
        assert_eq!(split.target_tab(), Some(3));
        split.close_secondary();
        assert!(!split.is_open());
        assert_eq!(split.target_tab(), None);
    }

    #[test]
    fn split_state_keeps_right_tab_when_left_tab_closes() {
        let mut split = SplitState::new();
        split.open_for(1);
        assert!(split.select_tab(2, &[1, 2]));

        // Close left tab 1; tab 2 remains open and becomes active.
        assert_eq!(split.reconcile_tabs(&[2], Some(2)), SplitReconcile::Keep(2));
        assert!(split.is_open());
        assert_eq!(split.target_tab(), Some(2));
    }

    #[test]
    fn split_state_falls_back_when_target_tab_closes_and_closes_when_empty() {
        let mut split = SplitState::new();
        split.open_for(2);

        assert_eq!(
            split.reconcile_tabs(&[1, 3], Some(1)),
            SplitReconcile::Fallback(1)
        );
        assert!(split.is_open());
        assert_eq!(split.target_tab(), Some(1));

        assert_eq!(split.reconcile_tabs(&[], None), SplitReconcile::Closed);
        assert!(!split.is_open());
        assert_eq!(split.target_tab(), None);
    }

    #[test]
    fn split_state_select_tab_and_parse_page_input_validate_bounds() {
        let mut split = SplitState::new();
        assert!(!split.select_tab(1, &[1, 2]));
        split.open_for(1);
        assert!(split.select_tab(2, &[1, 2]));
        assert!(!split.select_tab(9, &[1, 2]));
        assert_eq!(split.target_tab(), Some(2));

        assert_eq!(parse_page_input("1", 5), Some(0));
        assert_eq!(parse_page_input(" 5 ", 5), Some(4));
        assert_eq!(parse_page_input("0", 5), None);
        assert_eq!(parse_page_input("-1", 5), None);
        assert_eq!(parse_page_input("6", 5), None);
        assert_eq!(parse_page_input("abc", 5), None);
        assert_eq!(parse_page_input("1", 0), None);
    }
}
