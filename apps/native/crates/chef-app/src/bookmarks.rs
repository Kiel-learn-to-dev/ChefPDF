//! Data boundary for editing the PDF outline (R4.10).
//!
//! Keep the core's complete bookmark objects intact while the editor is open. The pdfium
//! `render::Bookmark` type is intentionally flat and omits destination/style fields, so it must
//! never be used as the source for `bookmarks.set`.

use serde_json::{Value, json};
use std::path::PathBuf;

use chef_pdf::render::DocId;

const MAX_BOOKMARKS: usize = 5_000;
const MAX_DEPTH: usize = 20;
const MAX_TITLE_CHARS: usize = 500;

/// Extract the full tree from a successful `bookmarks.get` operation reply.
pub fn tree_from_reply(reply: &Value) -> Result<Vec<Value>, String> {
    let tree = reply
        .get("data")
        .and_then(|data| data.get("bookmarks"))
        .and_then(Value::as_array)
        .ok_or_else(|| "Core returned an invalid bookmark tree".to_string())?;
    Ok(tree.clone())
}

/// Validate fields required by the core before submitting a complete replacement tree.
pub fn validate_tree(tree: &[Value], page_count: usize) -> Result<(), String> {
    let mut count = 0;
    validate_nodes(tree, page_count, 1, &mut count)
}

fn validate_nodes(
    nodes: &[Value],
    page_count: usize,
    depth: usize,
    count: &mut usize,
) -> Result<(), String> {
    if nodes.is_empty() {
        return Ok(());
    }
    if depth > MAX_DEPTH {
        return Err("Bookmark nesting is too deep".into());
    }
    for node in nodes {
        *count += 1;
        if *count > MAX_BOOKMARKS {
            return Err("There are too many bookmarks".into());
        }
        let title = node
            .get("title")
            .and_then(Value::as_str)
            .ok_or_else(|| "A bookmark title is missing".to_string())?;
        if title.trim().is_empty() || title.chars().count() > MAX_TITLE_CHARS {
            return Err("Bookmark titles must contain 1 to 500 characters".into());
        }
        if let Some(page) = node.get("page").filter(|page| !page.is_null()) {
            let page = page
                .as_u64()
                .and_then(|page| usize::try_from(page).ok())
                .ok_or_else(|| "A bookmark page index is invalid".to_string())?;
            if page >= page_count {
                return Err("A bookmark points outside this document".into());
            }
        }
        let children = node
            .get("children")
            .and_then(Value::as_array)
            .ok_or_else(|| "A bookmark child list is invalid".to_string())?;
        validate_nodes(children, page_count, depth + 1, count)?;
    }
    Ok(())
}

/// Editable snapshot tied to the document revision from which the core returned the tree.
pub struct Draft {
    pub tree: Vec<Value>,
    pub selected_path: Option<Vec<usize>>,
    pub base_doc: DocId,
    pub base_generation: u64,
    pub base_path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub path: Vec<usize>,
    pub depth: usize,
    pub title: String,
    pub page: Option<usize>,
}

impl Draft {
    pub fn rows(&self) -> Vec<Row> {
        let mut rows = Vec::new();
        flatten_rows(&self.tree, &mut Vec::new(), 0, &mut rows);
        rows
    }
}

fn flatten_rows(nodes: &[Value], parent: &mut Vec<usize>, depth: usize, rows: &mut Vec<Row>) {
    for (index, node) in nodes.iter().enumerate() {
        parent.push(index);
        rows.push(Row {
            path: parent.clone(),
            depth,
            title: node
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            page: node
                .get("page")
                .and_then(Value::as_u64)
                .and_then(|page| usize::try_from(page).ok()),
        });
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            flatten_rows(children, parent, depth + 1, rows);
        }
        parent.pop();
    }
}

/// Update one title by its child-index path, preserving every other core-provided field.
pub fn rename(tree: &mut [Value], path: &[usize], title: &str) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        return Err("Bookmark titles must contain 1 to 500 characters".into());
    }
    let (index, rest) = path
        .split_first()
        .ok_or_else(|| "A bookmark must be selected".to_string())?;
    let node = tree
        .get_mut(*index)
        .ok_or_else(|| "The selected bookmark no longer exists".to_string())?;
    if rest.is_empty() {
        node["title"] = Value::String(title.to_owned());
        return Ok(());
    }
    let children = node
        .get_mut("children")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "The selected bookmark has no child list".to_string())?;
    rename(children, rest, title)
}

/// Add a top-level bookmark and return its tree path.
pub fn add_root(
    tree: &mut Vec<Value>,
    title: &str,
    page: Option<usize>,
) -> Result<Vec<usize>, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        return Err("Bookmark titles must contain 1 to 500 characters".into());
    }
    if tree.len() >= MAX_BOOKMARKS {
        return Err("There are too many bookmarks".into());
    }
    let index = tree.len();
    tree.push(json!({
        "title": title,
        "page": page,
        "view": null,
        "open": true,
        "color": null,
        "bold": false,
        "italic": false,
        "children": []
    }));
    Ok(vec![index])
}

/// Remove a bookmark, returning its full object so callers can preserve or inspect its subtree.
pub fn remove(tree: &mut Vec<Value>, path: &[usize]) -> Result<Value, String> {
    let (index, parent) = path
        .split_last()
        .ok_or_else(|| "A bookmark must be selected".to_string())?;
    let siblings = siblings_mut(tree, parent)?;
    if *index >= siblings.len() {
        return Err("The selected bookmark no longer exists".into());
    }
    Ok(siblings.remove(*index))
}

/// Move a bookmark among siblings. `to_index` is its final index in that sibling list.
pub fn move_sibling(
    tree: &mut Vec<Value>,
    path: &[usize],
    to_index: usize,
) -> Result<Vec<usize>, String> {
    let (from_index, parent) = path
        .split_last()
        .ok_or_else(|| "A bookmark must be selected".to_string())?;
    let siblings = siblings_mut(tree, parent)?;
    if *from_index >= siblings.len() || to_index >= siblings.len() {
        return Err("The selected bookmark no longer exists".into());
    }
    let bookmark = siblings.remove(*from_index);
    siblings.insert(to_index, bookmark);
    let mut result = parent.to_vec();
    result.push(to_index);
    Ok(result)
}

/// Move a bookmark immediately before or after another bookmark at the same outline level.
pub fn move_relative(
    tree: &mut Vec<Value>,
    from: &[usize],
    target: &[usize],
    after: bool,
) -> Result<Vec<usize>, String> {
    let (from_index, from_parent) = from
        .split_last()
        .ok_or_else(|| "A bookmark must be selected".to_string())?;
    let (target_index, target_parent) = target
        .split_last()
        .ok_or_else(|| "A bookmark must be selected".to_string())?;
    if from_parent != target_parent {
        return Err("Bookmarks can only be reordered within the same outline level".into());
    }
    if from == target {
        return Ok(from.to_vec());
    }
    let insertion = target_index + usize::from(after);
    let destination = insertion - usize::from(from_index < &insertion);
    move_sibling(tree, from, destination)
}

fn siblings_mut<'a>(
    tree: &'a mut Vec<Value>,
    parent: &[usize],
) -> Result<&'a mut Vec<Value>, String> {
    if parent.is_empty() {
        return Ok(tree);
    }
    let (index, rest) = parent
        .split_first()
        .ok_or_else(|| "A bookmark path must select a row".to_string())?;
    let node = tree
        .get_mut(*index)
        .ok_or_else(|| "The selected bookmark no longer exists".to_string())?;
    let children = node
        .get_mut("children")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "The selected bookmark has no child list".to_string())?;
    if rest.is_empty() {
        Ok(children)
    } else {
        siblings_mut(children, rest)
    }
}

/// Build the core operation parameters without projecting away bookmark metadata.
pub fn set_params(tree: Vec<Value>) -> Value {
    json!({ "bookmarks": tree })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example_tree() -> Vec<Value> {
        vec![json!({
            "title": "Chapter",
            "page": 2,
            "view": { "type": "xyz", "left": 12.0, "top": 48.0, "zoom": 1.25 },
            "open": false,
            "color": "#123456",
            "bold": true,
            "italic": false,
            "children": [{
                "title": "Section",
                "page": 3,
                "view": null,
                "open": true,
                "color": null,
                "bold": false,
                "italic": true,
                "children": []
            }]
        })]
    }

    #[test]
    fn reads_full_tree_and_keeps_destinations_and_styles_when_renaming() {
        let tree = example_tree();
        let reply = json!({ "data": { "bookmarks": tree } });
        let mut parsed = tree_from_reply(&reply).unwrap();
        rename(&mut parsed, &[0, 0], "Overview").unwrap();

        assert_eq!(parsed[0]["children"][0]["title"], "Overview");
        assert_eq!(parsed[0]["view"]["type"], "xyz");
        assert_eq!(parsed[0]["view"]["zoom"], 1.25);
        assert_eq!(parsed[0]["open"], false);
        assert_eq!(parsed[0]["color"], "#123456");
        assert_eq!(parsed[0]["bold"], true);
        assert_eq!(parsed[0]["children"][0]["italic"], true);
    }

    #[test]
    fn validates_page_targets_and_title_limits() {
        let tree = example_tree();
        assert!(validate_tree(&tree, 4).is_ok());
        assert!(validate_tree(&tree, 3).is_err());

        let mut invalid = example_tree();
        invalid[0]["title"] = Value::String("  ".into());
        assert!(validate_tree(&invalid, 4).is_err());
    }

    #[test]
    fn accepts_maximum_supported_nesting_with_empty_leaf_children() {
        let mut node = json!({
            "title": "Level 20",
            "page": null,
            "children": []
        });
        for level in (1..MAX_DEPTH).rev() {
            node = json!({
                "title": format!("Level {level}"),
                "page": null,
                "children": [node]
            });
        }
        assert!(validate_tree(&[node], 1).is_ok());
    }

    #[test]
    fn flattens_nested_rows_with_paths_and_depth() {
        let draft = Draft {
            tree: example_tree(),
            selected_path: None,
            base_doc: 1,
            base_generation: 2,
            base_path: "/tmp/sample.pdf".into(),
        };
        let rows = draft.rows();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].path, vec![0]);
        assert_eq!(rows[0].depth, 0);
        assert_eq!(rows[1].path, vec![0, 0]);
        assert_eq!(rows[1].depth, 1);
        assert_eq!(rows[1].page, Some(3));
    }

    #[test]
    fn add_remove_and_reorder_keep_bookmark_metadata_and_subtrees() {
        let mut tree = example_tree();
        let added = add_root(&mut tree, "Appendix", Some(0)).unwrap();
        assert_eq!(added, vec![1]);
        tree[1]["color"] = Value::String("#abcdef".into());

        let moved = move_sibling(&mut tree, &[1], 0).unwrap();
        assert_eq!(moved, vec![0]);
        assert_eq!(tree[0]["title"], "Appendix");
        assert_eq!(tree[0]["color"], "#abcdef");
        assert_eq!(tree[1]["view"]["type"], "xyz");

        let removed = remove(&mut tree, &[1, 0]).unwrap();
        assert_eq!(removed["title"], "Section");
        assert_eq!(tree[1]["children"], json!([]));
    }

    #[test]
    fn move_relative_rejects_cross_level_and_places_before_or_after() {
        let mut tree = vec![
            json!({ "title": "A", "page": 0, "children": [] }),
            json!({ "title": "B", "page": 1, "children": [] }),
            json!({ "title": "C", "page": 2, "children": [] }),
        ];
        move_relative(&mut tree, &[0], &[2], true).unwrap();
        assert_eq!(tree[0]["title"], "B");
        assert_eq!(tree[1]["title"], "C");
        assert_eq!(tree[2]["title"], "A");
        assert!(move_relative(&mut tree, &[2], &[1, 0], false).is_err());
    }

    #[test]
    fn creates_set_params_with_original_tree() {
        let tree = example_tree();
        let params = set_params(tree.clone());
        assert_eq!(params["bookmarks"], json!(tree));
    }
}
