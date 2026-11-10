module github.com/happy-day-by-day/dbx_extensions/dbx-dbdoc/backend

go 1.25.0

toolchain go1.27.3

require github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk v0.0.0

replace github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk => ./third_party/dbx-plugin-sdk
