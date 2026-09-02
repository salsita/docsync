# docsync

`docsync` gives you a git workflow over documents that live in Notion and
Google Drive: you check documents out as Markdown files, edit them locally by
hand or with an agent, review the diff, and push. Nothing touches a source
document until you push, and when the source changed while you were working,
git's ordinary three-way merge resolves it. It installs two executables,
`docsync` and the git remote helper `git-remote-docsync`.

See [MANUAL.md](MANUAL.md) for the full specification.
