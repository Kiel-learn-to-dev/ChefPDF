# Chef PDF

App PDF desktop gọn gàng, mạnh mẽ, chạy trên Windows, macOS và Linux. Chỉ dùng cá nhân.

Hướng dẫn sử dụng: [Tiếng Việt](docs/HUONG_DAN_SU_DUNG.md)

Tài liệu dự án: [docs/NOTES.md](docs/NOTES.md) · [docs/FEATURES.md](docs/FEATURES.md) · [docs/BLUEPRINT.md](docs/BLUEPRINT.md) · [docs/TASKS.md](docs/TASKS.md) · [docs/CONTRACTS.md](docs/CONTRACTS.md)

## Phát triển

Cần: Node 22+, pnpm 10, Python 3.12+, [uv](https://docs.astral.sh/uv/).

```bash
pnpm install
(cd core && uv sync)
pnpm dev
```

Kiểm tra:

```bash
pnpm typecheck && pnpm lint && pnpm test
(cd core && uv run pytest && uv run ruff check . && uv run mypy)
```
