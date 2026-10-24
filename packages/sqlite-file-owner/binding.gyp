{
  "targets": [
    {
      "target_name": "mitzo_sqlite_file_owner",
      "sources": ["file_owner.c"],
      "include_dirs": [
        "<!(node -p \"require('path').dirname(require.resolve('better-sqlite3/package.json')) + '/deps/sqlite3'\")"
      ],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [["OS=='linux'", {"libraries": ["-ldl"]}]],
      "cflags": ["-Wall", "-Wextra"],
      "xcode_settings": {"WARNING_CFLAGS": ["-Wall", "-Wextra"]}
    }
  ]
}
