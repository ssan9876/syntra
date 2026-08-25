#!/usr/bin/env python3
"""The three GitHub release endpoints `syntra-update` actually calls.

Not a mock of GitHub. It answers exactly what the updater parses -- a
`tag_name`, an asset list carrying `name` and the API `url` (never
`browser_download_url`, which a private repository 404s), and the asset bytes
under an octet-stream Accept -- so that a rehearsal exercises the real
download, the real checksum check and the real unpack.

    ./release-server.py <directory-of-tarballs> <port>

Every syntra-<version>.tar.gz in the directory is a release; the highest
version is `latest`.
"""
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

DIR = sys.argv[1]
PORT = int(sys.argv[2])


def versions():
    found = []
    for name in os.listdir(DIR):
        m = re.fullmatch(r'syntra-([0-9.]+)\.tar\.gz', name)
        if m:
            found.append(m.group(1))
    return sorted(found, key=lambda v: [int(p) for p in v.split('.')])


def asset_id(version, index):
    # A bare, monotonically-increasing integer, matching the shape of
    # GitHub's real asset "url" field (.../releases/assets/<digits>).
    # `syntra-update`'s asset_url() regex (assets/[0-9]*") requires exactly
    # that -- a version/index path segment like "1.0.0/0" does not match,
    # and this only surfaced when something actually ran the real download
    # path against this stub for the first time.
    return versions().index(version) * 2 + index


def resolve_asset_id(asset_id_value):
    all_versions = versions()
    v_index, index = divmod(asset_id_value, 2)
    if v_index >= len(all_versions):
        return None
    return all_versions[v_index], index


def assets(version):
    out = []
    for index, name in enumerate(
        [f'syntra-{version}.tar.gz', f'syntra-{version}.tar.gz.sha256']
    ):
        out.append(
            # `url` before `name`: real GitHub release-asset objects list
            # `url` first, and syntra-update's asset_url() finds a name's
            # url by grepping one line *before* the matching "name" line
            # after a comma-split -- reversing this order breaks that.
            {
                'url': f'http://127.0.0.1:{PORT}/assets/{asset_id(version, index)}',
                'name': name,
            }
        )
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        m = re.fullmatch(r'/assets/([0-9]+)', self.path)
        if m:
            resolved = resolve_asset_id(int(m.group(1)))
            if resolved is None:
                self.send_error(404)
                return
            version, index = resolved
            name = [f'syntra-{version}.tar.gz', f'syntra-{version}.tar.gz.sha256'][index]
            path = os.path.join(DIR, name)
            if not os.path.exists(path):
                self.send_error(404)
                return
            with open(path, 'rb') as handle:
                body = handle.read()
            self.send_response(200)
            self.send_header('content-type', 'application/octet-stream')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        m = re.fullmatch(r'/repos/[^/]+/[^/]+/releases/tags/v([0-9.]+)', self.path)
        if m:
            version = m.group(1)
            if version not in versions():
                self.send_error(404)
                return
            return self.json({'tag_name': f'v{version}', 'assets': assets(version)})

        if re.fullmatch(r'/repos/[^/]+/[^/]+/releases/latest', self.path):
            available = versions()
            if not available:
                self.send_error(404)
                return
            version = available[-1]
            return self.json(
                {
                    'tag_name': f'v{version}',
                    'published_at': '2026-08-24T19:02:11Z',
                    'body': f'Rehearsal release {version}.',
                    'assets': assets(version),
                }
            )

        self.send_error(404)

    def json(self, body):
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
