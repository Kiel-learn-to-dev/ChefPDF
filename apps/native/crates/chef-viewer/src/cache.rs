//! Cache LRU giới hạn theo byte (TASKS_RUST R1.33). Thuần Rust.
//!
//! Mỗi mục có số byte riêng. Khi tổng vượt trần, bỏ mục ít dùng nhất cho tới khi vừa trần.
//! Mục vừa chèn không bao giờ bị bỏ ngay, kể cả khi riêng nó đã vượt trần (khi đó cache chỉ
//! giữ đúng mục đó). Các mục bị bỏ được trả về để bên gọi giải phóng tài nguyên (texture GPU).

use std::collections::HashMap;
use std::hash::Hash;

pub struct LruCache<K, V> {
    budget: usize,
    total: usize,
    tick: u64,
    items: HashMap<K, Entry<V>>,
}

struct Entry<V> {
    value: V,
    bytes: usize,
    last_used: u64,
}

impl<K: Eq + Hash + Clone, V> LruCache<K, V> {
    pub fn new(budget_bytes: usize) -> Self {
        LruCache {
            budget: budget_bytes,
            total: 0,
            tick: 0,
            items: HashMap::new(),
        }
    }

    pub fn budget(&self) -> usize {
        self.budget
    }

    pub fn total_bytes(&self) -> usize {
        self.total
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn contains(&self, key: &K) -> bool {
        self.items.contains_key(key)
    }

    /// Lấy giá trị và đánh dấu là vừa dùng.
    pub fn get(&mut self, key: &K) -> Option<&V> {
        self.tick += 1;
        let tick = self.tick;
        self.items.get_mut(key).map(|e| {
            e.last_used = tick;
            &e.value
        })
    }

    /// Chèn mục, bỏ các mục cũ nhất để vừa trần. Trả về các giá trị đã bị bỏ.
    /// Nếu khóa đã có, mục cũ được thay và trả về trong danh sách.
    pub fn insert(&mut self, key: K, value: V, bytes: usize) -> Vec<V> {
        self.tick += 1;
        let mut evicted = Vec::new();
        if let Some(old) = self.items.remove(&key) {
            self.total -= old.bytes;
            evicted.push(old.value);
        }
        self.total += bytes;
        self.items.insert(
            key.clone(),
            Entry {
                value,
                bytes,
                last_used: self.tick,
            },
        );

        while self.total > self.budget && self.items.len() > 1 {
            // Chọn mục ít dùng nhất, không chọn mục vừa chèn.
            let victim = self
                .items
                .iter()
                .filter(|(k, _)| **k != key)
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, _)| k.clone());
            let Some(victim) = victim else { break };
            if let Some(e) = self.items.remove(&victim) {
                self.total -= e.bytes;
                evicted.push(e.value);
            }
        }
        evicted
    }

    /// Bỏ một mục theo khóa, trả về giá trị nếu có.
    pub fn remove(&mut self, key: &K) -> Option<V> {
        self.items.remove(key).map(|e| {
            self.total -= e.bytes;
            e.value
        })
    }

    /// Đổi trần. Nếu tổng vượt trần mới, bỏ mục cũ nhất và trả về các giá trị đã bỏ.
    pub fn set_budget(&mut self, budget_bytes: usize) -> Vec<V> {
        self.budget = budget_bytes;
        let mut evicted = Vec::new();
        while self.total > self.budget && !self.items.is_empty() {
            let victim = self
                .items
                .iter()
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, _)| k.clone());
            let Some(victim) = victim else { break };
            if let Some(e) = self.items.remove(&victim) {
                self.total -= e.bytes;
                evicted.push(e.value);
            }
        }
        evicted
    }

    /// Lấy toàn bộ khóa hiện có (dùng cho kiểm thử và báo cáo).
    pub fn keys(&self) -> Vec<K> {
        self.items.keys().cloned().collect()
    }

    /// Read cache entries without marking them as recently used.
    pub fn entries(&self) -> impl Iterator<Item = (&K, &V)> {
        self.items.iter().map(|(key, entry)| (key, &entry.value))
    }
}

#[cfg(test)]
mod tests {
    use super::LruCache;

    #[test]
    fn entries_does_not_change_lru_eviction_order() {
        let mut cache = LruCache::new(2);
        cache.insert(1, "page-1", 1);
        cache.insert(2, "page-2", 1);
        assert_eq!(cache.entries().count(), 2);

        let evicted = cache.insert(3, "page-3", 1);
        assert_eq!(evicted, vec!["page-1"]);
        assert!(cache.contains(&2));
        assert!(cache.contains(&3));
    }
}
