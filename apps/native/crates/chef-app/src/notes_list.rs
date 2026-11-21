//! R4.20 note list filtering, flatten and CSV export helpers.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::notes::Note;

/// Filter applied to the notes list; `None` means "all".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NoteFilter {
    pub kind: Option<String>,
    pub author: Option<String>,
}

impl NoteFilter {
    pub fn matches(&self, note: &Note) -> bool {
        self.kind.as_deref().is_none_or(|kind| note.subtype == kind)
            && self
                .author
                .as_deref()
                .is_none_or(|author| note.author == author)
    }

    pub fn apply<'a>(&self, notes: &'a [Note]) -> Vec<&'a Note> {
        notes.iter().filter(|note| self.matches(note)).collect()
    }

    /// Cycle all → Text → FreeText → all.
    pub fn cycle_kind(&mut self) {
        self.kind = match self.kind.as_deref() {
            None => Some("Text".to_owned()),
            Some("Text") => Some("FreeText".to_owned()),
            _ => None,
        };
    }

    /// Cycle all → each distinct author (sorted) → all.
    pub fn cycle_author(&mut self, notes: &[Note]) {
        let mut authors: Vec<&str> = notes
            .iter()
            .map(|note| note.author.as_str())
            .filter(|author| !author.is_empty())
            .collect();
        authors.sort_unstable();
        authors.dedup();
        self.author = match self.author.as_deref() {
            None => authors.first().map(|a| (*a).to_owned()),
            Some(current) => authors
                .iter()
                .position(|a| *a == current)
                .and_then(|i| authors.get(i + 1))
                .map(|a| (*a).to_owned()),
        };
    }
}

/// Burn every annotation into the page content; links and form fields stay.
pub fn flatten_params() -> Value {
    json!({ "keepLinks": true, "keepFormFields": true })
}

/// CSV summary of the annotations of the current filter kind.
pub fn export_csv_params(output: &Path, kind: Option<&str>) -> Result<Value, String> {
    let output = output
        .to_str()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "Invalid export path".to_string())?;
    let mut params = json!({ "outputPath": output, "format": "csv" });
    if let Some(kind) = kind {
        params["kinds"] = json!([kind]);
    }
    Ok(params)
}

/// `<document stem>-notes.csv` next to the document.
pub fn csv_output_path(document: &Path) -> PathBuf {
    let stem = document
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("notes");
    document.with_file_name(format!("{stem}-notes.csv"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, subtype: &str, author: &str) -> Note {
        Note {
            id: id.into(),
            page_index: 0,
            subtype: subtype.into(),
            contents: String::new(),
            author: author.into(),
            replies: Vec::new(),
            in_reply_to: None,
            status: None,
            rect: [0.0; 4],
        }
    }

    #[test]
    fn filters_by_kind_and_author() {
        let notes = vec![
            note("a", "Text", "An"),
            note("b", "FreeText", "An"),
            note("c", "Text", "Binh"),
        ];
        let mut filter = NoteFilter::default();
        assert_eq!(filter.apply(&notes).len(), 3);
        filter.cycle_kind();
        assert_eq!(filter.apply(&notes).len(), 2);
        filter.cycle_author(&notes);
        assert_eq!(filter.author.as_deref(), Some("An"));
        assert_eq!(filter.apply(&notes).len(), 1);
        filter.cycle_author(&notes);
        filter.cycle_author(&notes);
        assert_eq!(filter.author, None);
        filter.cycle_kind();
        filter.cycle_kind();
        assert_eq!(filter.kind, None);
    }

    #[test]
    fn builds_flatten_and_csv_params() {
        assert_eq!(flatten_params()["keepLinks"], true);
        let path = csv_output_path(Path::new("C:/docs/report.pdf"));
        assert_eq!(path.file_name().unwrap(), "report-notes.csv");
        let params = export_csv_params(&path, Some("Text")).unwrap();
        assert_eq!(params["format"], "csv");
        assert_eq!(params["kinds"][0], "Text");
        assert!(
            export_csv_params(&path, None)
                .unwrap()
                .get("kinds")
                .is_none()
        );
    }
}
