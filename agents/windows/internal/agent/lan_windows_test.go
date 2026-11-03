//go:build windows

package agent

import (
	"bytes"
	"context"
	"net"
	"testing"
	"time"
)

func TestMagicPacketAndUnicastUDPTransport(t *testing.T) {
	packet, err := MagicPacket("02:11:22:33:44:55")
	if err != nil || len(packet) != 102 {
		t.Fatal("packet construction")
	}
	if !bytes.Equal(packet[:6], bytes.Repeat([]byte{255}, 6)) {
		t.Fatal("header")
	}
	for i := range 16 {
		if !bytes.Equal(packet[6+i*6:12+i*6], []byte{2, 17, 34, 51, 68, 85}) {
			t.Fatal("MAC repetition")
		}
	}
	receiver, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	if err = udpWrite("127.0.0.1", receiver.LocalAddr().(*net.UDPAddr), packet); err != nil {
		t.Fatal(err)
	}
	receiver.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 200)
	n, _, err := receiver.ReadFromUDP(buf)
	if err != nil || !bytes.Equal(buf[:n], packet) {
		t.Fatal("UDP did not carry exact magic packet")
	}
}
func TestWakeRejectsInvalidTargets(t *testing.T) {
	for _, mac := range []string{"FF:FF:FF:FF:FF:FF", "00:00:00:00:00:00", "whoami"} {
		if _, err := MagicPacket(mac); err == nil {
			t.Fatal("invalid MAC accepted")
		}
	}
	if validateSubnet("192.168.1.10", "192.168.2.10", "192.168.2.255", 24) || validateSubnet("8.8.8.8", "8.8.8.9", "8.8.8.255", 24) || validateSubnet("10.0.0.1", "10.0.0.2", "255.255.255.255", 32) {
		t.Fatal("invalid scope accepted")
	}
}
func TestNetworkEpochStableForUnchangedSnapshot(t *testing.T) {
	a := withEpoch(CollectInventory(), "same-runtime")
	b := withEpoch(CollectInventory(), "same-runtime")
	if a.NetworkEpoch != b.NetworkEpoch {
		t.Fatal("unchanged network epoch drifted")
	}
	if a.NetworkEpoch == withEpoch(CollectInventory(), "new-runtime").NetworkEpoch {
		t.Fatal("restart must invalidate evidence")
	}
}
func TestCommandReplayJournalSurvivesRestart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cfg := Config{DeviceID: "test", StateDir: t.TempDir()}
	first, err := NewLAN(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Minute).UnixMilli()
	if !first.mark("one-command", deadline) {
		t.Fatal("first command refused")
	}
	first.Close()
	second, err := NewLAN(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if second.mark("one-command", deadline) {
		t.Fatal("replay accepted after restart")
	}
}
