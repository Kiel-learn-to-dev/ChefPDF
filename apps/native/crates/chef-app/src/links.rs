//! R4.15 link management: wire helpers, URL allowlist, hit testing and launcher.

use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq)]
pub struct LinkItem {
    pub id: String,
    pub page_index: usize,
    pub kind: String,
    pub target_uri: Option<String>,
    pub target_page: Option<usize>,
    pub view: String,
    pub rect: [f32; 4],
    pub border_width: f32,
    pub color: Option<String>,
    pub highlight: String,
    pub flagged: bool,
}

impl LinkItem {
    pub fn display_target(&self) -> String {
        match self.kind.as_str() {
            "uri" => self.target_uri.clone().unwrap_or_default(),
            "page" => self
                .target_page
                .map_or_else(String::new, |page| format!("-> p.{}", page + 1)),
            other => format!("[{other}]"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkTargetKind {
    Uri,
    Page,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LinkFormMode {
    Add { page_index: usize, rect: [f32; 4] },
    Edit(String),
}

pub fn links_from_reply(reply: &Value) -> Result<Vec<LinkItem>, String> {
    let data = reply.get("data").unwrap_or(reply);
    let items = data
        .get("links")
        .and_then(Value::as_array)
        .ok_or_else(|| "Core returned an invalid link list".to_string())?;
    items
        .iter()
        .map(|item| {
            let rect = item
                .get("rect")
                .and_then(Value::as_array)
                .filter(|rect| rect.len() == 4)
                .and_then(|rect| rect.iter().map(Value::as_f64).collect::<Option<Vec<_>>>())
                .ok_or_else(|| "Core returned invalid link geometry".to_string())?;
            let kind = item
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let target_uri = if kind == "uri" {
                item.get("target")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            } else {
                None
            };
            let target_page = if kind == "page" {
                item.get("target")
                    .and_then(Value::as_u64)
                    .and_then(|page| usize::try_from(page).ok())
            } else {
                None
            };
            Ok(LinkItem {
                id: item
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Core returned a link without an ID".to_string())?
                    .to_owned(),
                page_index: item
                    .get("pageIndex")
                    .and_then(Value::as_u64)
                    .and_then(|page| usize::try_from(page).ok())
                    .ok_or_else(|| "Core returned an invalid link page".to_string())?,
                kind,
                target_uri,
                target_page,
                view: item
                    .get("view")
                    .and_then(Value::as_str)
                    .unwrap_or("fit")
                    .to_owned(),
                rect: [
                    rect[0] as f32,
                    rect[1] as f32,
                    rect[2] as f32,
                    rect[3] as f32,
                ],
                border_width: item
                    .get("borderWidth")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0) as f32,
                color: item.get("color").and_then(Value::as_str).map(str::to_owned),
                highlight: item
                    .get("highlight")
                    .and_then(Value::as_str)
                    .unwrap_or("invert")
                    .to_owned(),
                flagged: item
                    .get("flagged")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

fn unsupported_uri_err() -> String {
    "Only http, https, and mailto URLs are allowed.".to_string()
}

fn valid_mailto_body(body: &str) -> bool {
    let mut parts = body.split('@');
    let Some(local) = parts.next() else {
        return false;
    };
    let Some(host) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && !local.is_empty()
        && !host.is_empty()
        && host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
}

fn valid_http_rest(rest: &str) -> bool {
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty() && !host.starts_with('/')
}

fn has_scheme_prefix(s: &str) -> Option<(&str, &str)> {
    let colon = s.find(':')?;
    let scheme = &s[..colon];
    let mut chars = scheme.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    if chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        Some((scheme, &s[colon + 1..]))
    } else {
        None
    }
}

/// Normalize bare hosts/emails and enforce the strict http/https/mailto allowlist.
pub fn normalize_and_validate_uri(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty()
        || s.starts_with("//")
        || s.contains('\\')
        || s.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(unsupported_uri_err());
    }
    if let Some((scheme, rest)) = has_scheme_prefix(s) {
        let lower = scheme.to_ascii_lowercase();
        match lower.as_str() {
            "http" | "https" => {
                if let Some(after) = rest.strip_prefix("//")
                    && valid_http_rest(after)
                {
                    return Ok(format!("{lower}://{after}"));
                }
                return Err(unsupported_uri_err());
            }
            "mailto" => {
                if valid_mailto_body(rest) {
                    return Ok(format!("mailto:{rest}"));
                }
                return Err(unsupported_uri_err());
            }
            _ => return Err(unsupported_uri_err()),
        }
    }
    if s.contains(':') {
        return Err(unsupported_uri_err());
    }
    if s.contains('@') {
        if valid_mailto_body(s) {
            return Ok(format!("mailto:{s}"));
        }
        return Err(unsupported_uri_err());
    }
    let host = s.split(['/', '?', '#']).next().unwrap_or("");
    if !host.is_empty() && host.contains('.') && !host.starts_with('.') && !host.ends_with('.') {
        Ok(format!("https://{s}"))
    } else {
        Err(unsupported_uri_err())
    }
}

/// Strict validator for opening an already-stored URI without auto-prepending a scheme.
pub fn validate_open_uri(uri: &str) -> Result<String, String> {
    let s = uri.trim();
    if s.is_empty() || s.contains('\\') || s.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(unsupported_uri_err());
    }
    let Some((scheme, rest)) = has_scheme_prefix(s) else {
        return Err(unsupported_uri_err());
    };
    let lower = scheme.to_ascii_lowercase();
    match lower.as_str() {
        "http" | "https" => {
            if let Some(after) = rest.strip_prefix("//")
                && valid_http_rest(after)
            {
                return Ok(format!("{lower}://{after}"));
            }
            Err(unsupported_uri_err())
        }
        "mailto" => {
            if valid_mailto_body(rest) {
                Ok(format!("mailto:{rest}"))
            } else {
                Err(unsupported_uri_err())
            }
        }
        _ => Err(unsupported_uri_err()),
    }
}

pub fn parse_page_target(input: &str, page_count: usize) -> Result<usize, String> {
    let page = input
        .trim()
        .parse::<usize>()
        .map_err(|_| "Invalid page number.".to_string())?;
    if page == 0 || page > page_count {
        return Err("Invalid page number.".to_string());
    }
    Ok(page - 1)
}

pub fn add_link_params(
    page_index: usize,
    rect: [f32; 4],
    kind: LinkTargetKind,
    value: &str,
    page_count: usize,
) -> Result<Value, String> {
    if rect.iter().any(|v| !v.is_finite() || *v < 0.0) || rect[2] <= rect[0] || rect[3] <= rect[1] {
        return Err("The link rectangle is invalid".to_string());
    }
    match kind {
        LinkTargetKind::Uri => {
            let uri = normalize_and_validate_uri(value)?;
            Ok(json!({
                "pageIndex": page_index,
                "rect": rect,
                "kind": "uri",
                "uri": uri,
            }))
        }
        LinkTargetKind::Page => {
            let target_page = parse_page_target(value, page_count)?;
            Ok(json!({
                "pageIndex": page_index,
                "rect": rect,
                "kind": "page",
                "targetPage": target_page,
                "view": "fit",
            }))
        }
    }
}

pub fn update_link_params(
    id: &str,
    kind: LinkTargetKind,
    value: &str,
    page_count: usize,
) -> Result<Value, String> {
    if id.is_empty() {
        return Err("The link ID is invalid".to_string());
    }
    match kind {
        LinkTargetKind::Uri => {
            let uri = normalize_and_validate_uri(value)?;
            Ok(json!({ "id": id, "uri": uri }))
        }
        LinkTargetKind::Page => {
            let target_page = parse_page_target(value, page_count)?;
            Ok(json!({ "id": id, "targetPage": target_page, "view": "fit" }))
        }
    }
}

pub fn remove_link_params(id: &str) -> Result<Value, String> {
    if id.is_empty() {
        return Err("The link ID is invalid".to_string());
    }
    Ok(json!({ "ids": [id] }))
}

/// Topmost link under `point` on `page_index` (displayed frame, points, origin top-left).
pub fn link_at_point(links: &[LinkItem], page_index: usize, point: [f32; 2]) -> Option<&LinkItem> {
    links.iter().rev().find(|link| {
        link.page_index == page_index
            && point[0] >= link.rect[0]
            && point[0] <= link.rect[2]
            && point[1] >= link.rect[1]
            && point[1] <= link.rect[3]
    })
}

#[cfg(windows)]
#[link(name = "shell32")]
unsafe extern "system" {
    fn ShellExecuteW(
        hwnd: isize,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show_cmd: i32,
    ) -> isize;
}

pub fn open_external_url(uri: &str) -> Result<String, String> {
    let validated = validate_open_uri(uri)?;
    crate::debug::set_opened_url(Some(&validated));
    #[cfg(windows)]
    if std::env::var_os("CHEF_E2E").is_none() {
        let op: Vec<u16> = "open\0".encode_utf16().collect();
        let mut target: Vec<u16> = validated.encode_utf16().collect();
        target.push(0);
        // SAFETY: both pointers are null-terminated UTF-16 buffers valid for the call duration.
        let rc = unsafe {
            ShellExecuteW(
                0,
                op.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if rc <= 32 {
            return Err(format!("Failed to open URL (code {rc})"));
        }
    }
    Ok(validated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_links_reply() {
        let reply = json!({"data": {"links": [
            {"id": "K0:abc:0", "pageIndex": 0, "kind": "uri", "target": "https://example.com", "rect": [10.0, 20.0, 110.0, 40.0], "borderWidth": 1.0, "color": "#0000ff", "highlight": "invert", "flagged": false},
            {"id": "K0:abc:1", "pageIndex": 0, "kind": "page", "target": 2, "view": "fit", "rect": [10.0, 60.0, 110.0, 80.0], "borderWidth": 0.0, "color": null, "highlight": "none", "flagged": false},
            {"id": "K0:abc:2", "pageIndex": 0, "kind": "javascript", "target": null, "rect": [10.0, 90.0, 110.0, 110.0], "flagged": true}
        ]}});
        let links = links_from_reply(&reply).unwrap();
        assert_eq!(links.len(), 3);
        assert_eq!(links[0].target_uri.as_deref(), Some("https://example.com"));
        assert_eq!(links[1].target_page, Some(2));
        assert!(links[2].flagged);
    }

    #[test]
    fn rejects_non_allowlisted_uris_and_normalizes_valid_ones() {
        assert_eq!(
            normalize_and_validate_uri("https://example.com/a?x=1").unwrap(),
            "https://example.com/a?x=1"
        );
        assert_eq!(
            normalize_and_validate_uri("HTTP://example.com").unwrap(),
            "http://example.com"
        );
        assert_eq!(
            normalize_and_validate_uri("mailto:hello@example.com").unwrap(),
            "mailto:hello@example.com"
        );
        assert_eq!(
            normalize_and_validate_uri("hello@example.com").unwrap(),
            "mailto:hello@example.com"
        );
        assert_eq!(
            normalize_and_validate_uri("example.com/docs").unwrap(),
            "https://example.com/docs"
        );

        for bad in [
            "",
            "   ",
            "javascript:alert(1)",
            "JavaScript:void(0)",
            "vbscript:msgbox(1)",
            "file:///C:/Windows/win.ini",
            "ftp://example.com/pub",
            "data:text/html,<script>",
            "tel:+84123456",
            "//evil.example.com",
            "https://",
            "https://ex ample.com",
            "mailto:bad",
        ] {
            assert!(
                normalize_and_validate_uri(bad).is_err(),
                "expected rejection for {bad:?}"
            );
            assert!(
                validate_open_uri(bad).is_err(),
                "expected open rejection for {bad:?}"
            );
        }
        assert!(validate_open_uri("example.com").is_err());
    }

    #[test]
    fn builds_params_and_hits_topmost_link() {
        let add =
            add_link_params(0, [10.0, 20.0, 110.0, 50.0], LinkTargetKind::Page, "2", 3).unwrap();
        assert_eq!(add["kind"], "page");
        assert_eq!(add["targetPage"], 1);
        assert!(
            add_link_params(0, [10.0, 20.0, 110.0, 50.0], LinkTargetKind::Page, "4", 3).is_err()
        );
        let upd = update_link_params("K0:abc:0", LinkTargetKind::Uri, "mailto:a@b.vn", 3).unwrap();
        assert_eq!(upd["uri"], "mailto:a@b.vn");
        assert_eq!(
            remove_link_params("K0:abc:0").unwrap()["ids"][0],
            "K0:abc:0"
        );

        let links = vec![
            LinkItem {
                id: "first".into(),
                page_index: 0,
                kind: "uri".into(),
                target_uri: Some("https://a.com".into()),
                target_page: None,
                view: "fit".into(),
                rect: [10.0, 10.0, 100.0, 50.0],
                border_width: 0.0,
                color: None,
                highlight: "invert".into(),
                flagged: false,
            },
            LinkItem {
                id: "top".into(),
                page_index: 0,
                kind: "page".into(),
                target_uri: None,
                target_page: Some(1),
                view: "fit".into(),
                rect: [20.0, 20.0, 90.0, 40.0],
                border_width: 0.0,
                color: None,
                highlight: "invert".into(),
                flagged: false,
            },
        ];
        assert_eq!(
            link_at_point(&links, 0, [50.0, 30.0]).map(|l| l.id.as_str()),
            Some("top")
        );
        assert!(link_at_point(&links, 0, [5.0, 5.0]).is_none());
    }
}
