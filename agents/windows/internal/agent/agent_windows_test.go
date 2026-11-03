//go:build windows

package agent

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestTransportOrigins(t *testing.T) {
	for _, s := range []string{"https://example.com", "http://localhost:4100", "http://127.0.0.1:4100", "http://[::1]:4100"} {
		if _, err := ValidateServer(s); err != nil {
			t.Fatalf("allowed %s: %v", s, err)
		}
	}
	for _, s := range []string{"http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com?token=x", "file:///tmp/a", "ws://example.com"} {
		if _, err := ValidateServer(s); err == nil {
			t.Fatalf("unsafe origin accepted: %s", s)
		}
	}
}
func TestDPAPIAtRest(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "identity")
	cfg := Config{Server: "https://example.com", DeviceID: "device-id", Token: "secret-not-plaintext"}
	if err := Save(dir, cfg, false); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "agent.dpapi"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(cfg.Token)) {
		t.Fatal("plaintext token persisted")
	}
	loaded, err := Load(dir, false)
	if err != nil || loaded != cfg {
		t.Fatalf("DPAPI roundtrip: %v", err)
	}
}
func TestInventoryIsBoundedAndHonest(t *testing.T) {
	v := CollectInventory()
	if v.Hostname == "" || v.CPU == "" || v.MemoryBytes == 0 {
		t.Fatal("hardware missing")
	}
	if len(v.Interfaces) > 32 {
		t.Fatal("interface bound")
	}
	for _, i := range v.Interfaces {
		if i.WolSupport != "unknown" {
			t.Fatal("unproven WoL capability")
		}
		for _, a := range i.Addresses {
			if net.ParseIP(a.Address) == nil {
				t.Fatal("invalid address")
			}
		}
	}
	if _, err := json.Marshal(v); err != nil {
		t.Fatal(err)
	}
}
func TestAdapterIdentityIsStable(t *testing.T) {
	first := CollectInventory()
	second := CollectInventory()
	if len(first.Interfaces) != len(second.Interfaces) {
		t.Skip("network interfaces changed during test")
	}
	for i, network := range first.Interfaces {
		if network.NativeID == "" || network.NativeID != second.Interfaces[i].NativeID {
			t.Fatal("adapter identity unstable")
		}
	}
}
func TestBroadcastCalculation(t *testing.T) {
	v := broadcast(net.ParseIP("192.168.7.11"), net.CIDRMask(24, 32))
	if v == nil || *v != "192.168.7.255" {
		t.Fatal("bad broadcast")
	}
	if broadcast(net.ParseIP("10.0.0.1"), net.CIDRMask(32, 32)) != nil {
		t.Fatal("no broadcast on /32")
	}
}
func TestWindows11LegacyProductName(t *testing.T){if windowsDisplayName("Windows 10 Pro","26300")!="Windows 11 Pro"{t.Fatal("Windows 11 build mislabeled")};if windowsDisplayName("Windows 10 Pro","19045")!="Windows 10 Pro"{t.Fatal("Windows 10 renamed")};if windowsDisplayName("Windows Server 2025","26100")!="Windows Server 2025"{t.Fatal("server mislabeled")}}
