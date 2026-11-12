package main

import (
	"encoding/json"
	"fmt"
	"os"

	sdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

const pluginVersion = "0.4.38"

func main() {
	dir, err := sdk.EnsureDataDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	store, err := newDirectoryStore(dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer store.close()
	server := sdk.NewServer(sdk.Metadata{ID: "com.sazs.dbdoc", Version: pluginVersion, Capabilities: []string{}}, sdk.HandlerFunc(func(_ sdk.RequestContext, method string, params json.RawMessage, _ *sdk.Emitter) (any, *sdk.PluginError) {
		result, err := store.handle(method, params)
		if err != nil {
			return nil, sdk.NewError(-32000, err.Error())
		}
		return result, nil
	}))
	if err := server.Serve(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
