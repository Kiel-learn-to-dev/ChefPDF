//! Command registry and diacritic-insensitive ranking (R2.18).

use chef_pdf::search::fold_query;

use gpui::{Action, App, KeyBinding, actions};

actions!(native_commands, [OpenPalette, PaletteNext, PalettePrevious]);

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("ctrl-k", OpenPalette, Some("Viewer")),
        KeyBinding::new("ctrl-k", OpenPalette, Some("TextInput")),
        // Vertical navigation is handled only by the command host while the palette is open.
        KeyBinding::new("up", PalettePrevious, Some("TextInput")),
        KeyBinding::new("down", PaletteNext, Some("TextInput")),
    ]);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandAction {
    OpenPdf,
    Find,
    ZoomIn,
    ZoomOut,
    ZoomReset,
    ZoomFitPage,
    RotateViewLeft,
    RotateViewRight,
    RotatePage,
    Undo,
    Redo,
    Save,
    Settings,
    Unavailable,
    ViewContinuous,
    ViewTwoPage,
    ViewBook,
    ViewSlideshow,
}

impl CommandAction {
    pub fn gpui_action(self) -> Option<Box<dyn Action>> {
        use crate::viewer as v;
        Some(match self {
            Self::OpenPdf => Box::new(v::OpenFile),
            Self::Find => Box::new(v::FocusSearch),
            Self::ZoomIn => Box::new(v::ZoomIn),
            Self::ZoomOut => Box::new(v::ZoomOut),
            Self::ZoomReset => Box::new(v::ZoomReset),
            Self::ZoomFitPage => Box::new(v::ZoomFitPage),
            Self::RotateViewLeft => Box::new(v::RotateViewLeft),
            Self::RotateViewRight => Box::new(v::RotateViewRight),
            Self::RotatePage => Box::new(v::RotatePage),
            Self::Undo => Box::new(v::UndoEdit),
            Self::Redo => Box::new(v::RedoEdit),
            Self::Save => Box::new(v::SaveEdit),
            Self::Settings => Box::new(v::OpenSettings),
            Self::ViewContinuous => Box::new(v::SetContinuous),
            Self::ViewTwoPage => Box::new(v::SetTwoPage),
            Self::ViewBook => Box::new(v::SetBook),
            Self::ViewSlideshow => Box::new(v::SetSlideshow),
            Self::Unavailable => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Command {
    pub id: String,
    pub title: String,
    pub keywords: Vec<String>,
    pub group: String,
    pub action: CommandAction,
}

impl Command {
    pub fn new(
        id: impl Into<String>,
        title: impl Into<String>,
        group: impl Into<String>,
        action: CommandAction,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            keywords: Vec::new(),
            group: group.into(),
            action,
        }
    }

    pub fn keywords(mut self, keywords: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.keywords = keywords.into_iter().map(Into::into).collect();
        self
    }

    pub fn is_available(&self) -> bool {
        self.action != CommandAction::Unavailable
    }
}

#[derive(Default, Debug)]
pub struct CommandRegistry {
    commands: Vec<Command>,
}

impl CommandRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register one command. IDs are unique; a later registration replaces the earlier entry in
    /// place, so milestones can override metadata without changing palette order.
    pub fn register(&mut self, command: Command) {
        if let Some(existing) = self.commands.iter_mut().find(|item| item.id == command.id) {
            *existing = command;
        } else {
            self.commands.push(command);
        }
    }

    pub fn all(&self) -> &[Command] {
        &self.commands
    }

    /// Search titles and keywords using the same Unicode folding as PDF text search (R2.23).
    /// Results are ranked by exact title, title prefix, token prefix, then substring. Equal scores
    /// retain registration order, and disabled commands remain discoverable.
    pub fn search(&self, query: &str) -> Vec<&Command> {
        let needle = normalized(query);
        let mut ranked: Vec<(usize, u32, &Command)> = self
            .commands
            .iter()
            .enumerate()
            .filter_map(|(index, command)| {
                score(&needle, command).map(|score| (index, score, command))
            })
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        ranked.into_iter().map(|(_, _, command)| command).collect()
    }
}

fn normalized(text: &str) -> String {
    fold_query(text).into_iter().collect()
}

fn score(query: &str, command: &Command) -> Option<u32> {
    if query.is_empty() {
        return Some(0);
    }
    let title = normalized(&command.title);
    let keywords: Vec<String> = command
        .keywords
        .iter()
        .map(|word| normalized(word))
        .collect();
    if query == title {
        return Some(1000);
    }
    if title.starts_with(query) {
        return Some(900_u32.saturating_sub(title.len() as u32));
    }
    let tokens: Vec<&str> = query.split_whitespace().collect();
    let words: Vec<&str> = title.split_whitespace().collect();
    if tokens.iter().all(|token| {
        words.iter().any(|word| word.starts_with(token))
            || keywords.iter().any(|keyword| {
                keyword
                    .split_whitespace()
                    .any(|word| word.starts_with(token))
            })
    }) {
        return Some(800_u32.saturating_sub(title.len() as u32));
    }
    if title.contains(query) {
        return Some(700);
    }
    if keywords.iter().any(|keyword| keyword.contains(query)) {
        return Some(600);
    }
    if tokens.iter().all(|token| {
        title.contains(token) || keywords.iter().any(|keyword| keyword.contains(token))
    }) {
        return Some(500);
    }
    None
}

/// Registry of implemented viewer actions plus discoverable commands that remain unavailable.
pub fn viewer_commands(t: impl Fn(&str) -> String) -> CommandRegistry {
    use CommandAction as A;
    let mut commands = CommandRegistry::new();
    for command in [
        Command::new(
            "file.open",
            t("commands.openPdf"),
            t("palette.group.file"),
            A::OpenPdf,
        )
        .keywords(["open", "mo pdf", "tep"]),
        Command::new(
            "viewer.find",
            t("commands.find"),
            t("palette.group.view"),
            A::Find,
        )
        .keywords(["search", "tim", "tim trong tai lieu"]),
        Command::new(
            "viewer.mode.continuous",
            t("viewer.modeContinuous"),
            t("palette.group.view"),
            A::ViewContinuous,
        )
        .keywords(["single page", "lien tuc"]),
        Command::new(
            "viewer.mode.twoPage",
            t("viewer.modeTwoPage"),
            t("palette.group.view"),
            A::ViewTwoPage,
        )
        .keywords(["two page", "hai trang"]),
        Command::new(
            "viewer.mode.book",
            t("viewer.modeBook"),
            t("palette.group.view"),
            A::ViewBook,
        )
        .keywords(["book", "sach"]),
        Command::new(
            "viewer.mode.slideshow",
            t("viewer.modeSlideshow"),
            t("palette.group.view"),
            A::ViewSlideshow,
        )
        .keywords(["presentation", "trinh chieu"]),
        Command::new(
            "viewer.zoomIn",
            t("commands.zoomIn"),
            t("palette.group.view"),
            A::ZoomIn,
        )
        .keywords(["zoom in", "zoom", "phong to"]),
        Command::new(
            "viewer.zoomOut",
            t("commands.zoomOut"),
            t("palette.group.view"),
            A::ZoomOut,
        )
        .keywords(["zoom", "thu nho"]),
        Command::new(
            "viewer.zoomReset",
            t("commands.zoomReset"),
            t("palette.group.view"),
            A::ZoomReset,
        )
        .keywords(["zoom", "vua khung"]),
        Command::new(
            "viewer.zoomFitPage",
            t("commands.zoomFitPage"),
            t("palette.group.view"),
            A::ZoomFitPage,
        )
        .keywords(["fit page", "vua trang"]),
        Command::new(
            "viewer.rotateViewLeft",
            t("commands.rotateViewLeft"),
            t("palette.group.view"),
            A::RotateViewLeft,
        )
        .keywords(["rotate view left", "xoay khung trai"]),
        Command::new(
            "viewer.rotateViewRight",
            t("commands.rotateViewRight"),
            t("palette.group.view"),
            A::RotateViewRight,
        )
        .keywords(["rotate view right", "xoay khung phai"]),
        Command::new(
            "viewer.rotate",
            t("commands.rotatePage"),
            t("palette.group.pages"),
            A::RotatePage,
        )
        .keywords(["rotate", "xoay trang"]),
        Command::new(
            "edit.undo",
            t("commands.undo"),
            t("palette.group.edit"),
            A::Undo,
        )
        .keywords(["ctrl z", "hoan tac"]),
        Command::new(
            "edit.redo",
            t("commands.redo"),
            t("palette.group.edit"),
            A::Redo,
        )
        .keywords(["ctrl y", "lam lai"]),
        Command::new(
            "file.save",
            t("commands.save"),
            t("palette.group.file"),
            A::Save,
        )
        .keywords(["ctrl s", "luu"]),
        Command::new(
            "app.settings",
            t("commands.settings"),
            t("palette.group.app"),
            A::Settings,
        )
        .keywords(["preferences", "cai dat"]),
        Command::new(
            "sign.document",
            t("commands.sign"),
            t("palette.group.soon"),
            A::Unavailable,
        )
        .keywords(["ky so", "sign pdf", "token"]),
        Command::new(
            "pages.decree30",
            t("commands.decree30"),
            t("palette.group.soon"),
            A::Unavailable,
        )
        .keywords(["nghi dinh", "nghi dinh 30", "page number", "so trang"]),
    ] {
        commands.register(command);
    }
    commands
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commands() -> CommandRegistry {
        let mut registry = CommandRegistry::new();
        registry.register(Command::new(
            "sign",
            "Ký số",
            "tools",
            CommandAction::Unavailable,
        ));
        registry.register(Command::new(
            "decree30",
            "Số trang theo Nghị định 30",
            "pages",
            CommandAction::Unavailable,
        ));
        registry
    }

    #[test]
    fn searches_vietnamese_titles_without_diacritics() {
        let registry = commands();
        assert_eq!(registry.search("ky so")[0].id, "sign");
        assert_eq!(registry.search("nghi dinh")[0].id, "decree30");
    }

    #[test]
    fn viewer_registry_includes_searchable_signature_and_decree_commands() {
        let registry = viewer_commands(|key| match key {
            "commands.sign" => "Ký số".into(),
            "commands.decree30" => "Số trang theo Nghị định 30".into(),
            _ => key.into(),
        });
        assert_eq!(registry.search("ky so")[0].id, "sign.document");
        assert_eq!(registry.search("nghi dinh")[0].id, "pages.decree30");
        assert!(!registry.search("ky so")[0].is_available());
    }

    #[test]
    fn registration_exposes_new_commands_and_replaces_duplicate_ids() {
        let mut registry = commands();
        registry.register(Command::new(
            "tools.scan",
            "Chuyển thành bản scan",
            "tools",
            CommandAction::Unavailable,
        ));
        assert_eq!(registry.all().len(), 3);
        assert_eq!(registry.search("ban scan")[0].id, "tools.scan");
        registry.register(Command::new(
            "sign",
            "Ký tài liệu",
            "tools",
            CommandAction::Unavailable,
        ));
        assert_eq!(registry.all().len(), 3);
        assert_eq!(registry.search("ky tai lieu")[0].title, "Ký tài liệu");
    }

    #[test]
    fn ranks_exact_and_prefix_matches_ahead_of_substrings() {
        let mut registry = CommandRegistry::new();
        registry.register(Command::new(
            "prefix",
            "File gần đây",
            "file",
            CommandAction::Unavailable,
        ));
        registry.register(Command::new(
            "inside",
            "Ghép file",
            "file",
            CommandAction::Unavailable,
        ));
        assert_eq!(
            registry
                .search("file")
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            ["prefix", "inside"]
        );
    }
}
