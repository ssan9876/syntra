"""MkDocs hook: point links to files outside docs/ at GitHub.

The docs link to repository files with relative paths such as
`../deploy/helm/syntra/README.md`. Those work when the Markdown is read on
GitHub. The built site has no such files, so this hook rewrites each one to
the same path on GitHub before MkDocs validates links.
"""

import posixpath
import re

LINK = re.compile(r"\]\((?P<target>\.\./[^)\s#]*)(?P<anchor>#[^)\s]*)?\)")


def on_page_markdown(markdown, page, config, files):
    repo = (config.get("repo_url") or "").rstrip("/")
    if not repo:
        return markdown
    page_dir = posixpath.dirname(page.file.src_uri)

    def rewrite(match):
        target = match.group("target")
        anchor = match.group("anchor") or ""
        resolved = posixpath.normpath(posixpath.join("docs", page_dir, target))
        if resolved == "docs" or resolved.startswith("docs/"):
            return match.group(0)
        kind = "tree" if target.endswith("/") else "blob"
        return f"]({repo}/{kind}/main/{resolved}{anchor})"

    return LINK.sub(rewrite, markdown)
