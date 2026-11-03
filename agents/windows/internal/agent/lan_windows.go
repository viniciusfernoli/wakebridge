//go:build windows

package agent

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const DiscoveryPort = 34780

type ServerCommand struct {
	Type        string          `json:"type"`
	Version     int             `json:"version"`
	Seq         int64           `json:"seq"`
	CommandID   string          `json:"commandId"`
	OperationID string          `json:"operationId"`
	SessionID   string          `json:"sessionId"`
	ExpiresAt   int64           `json:"expiresAt"`
	Action      string          `json:"action"`
	Payload     json.RawMessage `json:"payload"`
}
type WolPayload struct {
	LocalInterfaceID string `json:"localInterfaceId"`
	LocalAddress     string `json:"localAddress"`
	NetworkEpoch     string `json:"networkEpoch"`
	TargetAddress    string `json:"targetAddress"`
	PrefixLength     int    `json:"prefixLength"`
	Broadcast        string `json:"broadcast"`
	MAC              string `json:"mac"`
}
type ProbePayload struct {
	TicketID         string `json:"ticketId"`
	Secret           string `json:"secret"`
	PeerDeviceID     string `json:"peerDeviceId"`
	LocalInterfaceID string `json:"localInterfaceId"`
	LocalAddress     string `json:"localAddress"`
	PeerAddress      string `json:"peerAddress"`
	PrefixLength     int    `json:"prefixLength"`
	Broadcast        string `json:"broadcast"`
	NetworkEpoch     string `json:"networkEpoch"`
}
type Datagram struct {
	Version       int    `json:"version"`
	Kind          string `json:"kind"`
	TicketID      string `json:"ticketId"`
	From          string `json:"from"`
	To            string `json:"to"`
	Nonce         string `json:"nonce"`
	ResponseNonce string `json:"responseNonce"`
	Signature     string `json:"signature"`
}
type probe struct {
	Payload   ProbePayload
	Deadline  int64
	Nonce     string
	Initiator bool
	Used      bool
}
type LAN struct {
	ctx    context.Context
	cfg    Config
	socket *net.UDPConn
	salt   string
	mu     sync.Mutex
	probes map[string]*probe
	seen   map[string]int64
	Events chan map[string]any
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func NewLAN(ctx context.Context, cfg Config) (*LAN, error) {
	if cfg.StateDir == "" {
		return nil, errors.New("persistent command directory required")
	}
	sock, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: DiscoveryPort})
	if err != nil {
		return nil, err
	}
	l := &LAN{ctx: ctx, cfg: cfg, socket: sock, salt: randomHex(16), probes: make(map[string]*probe), seen: make(map[string]int64), Events: make(chan map[string]any, 16)}
	if raw, err := os.ReadFile(filepath.Join(cfg.StateDir, "commands.json")); err == nil {
		if json.Unmarshal(raw, &l.seen) != nil {
			sock.Close()
			return nil, errors.New("invalid command journal")
		}
	}
	go l.receive()
	return l, nil
}
func (l *LAN) Close() { l.socket.Close() }
func (l *LAN) Inventory() Inventory {
	v := withEpoch(CollectInventory(), l.salt)
	v.LANEnabled = true
	v.Capabilities = []string{"inventory", "wol", "discovery"}
	return v
}
func withEpoch(v Inventory, salt string) Inventory {
	items := []string{salt, gatewayFingerprint()}
	for _, n := range v.Interfaces {
		items = append(items, fmt.Sprintf("%s:%t", n.NativeID, n.IsUp))
		for _, a := range n.Addresses {
			items = append(items, fmt.Sprintf("%s:%s/%d", n.NativeID, a.Address, a.PrefixLength))
		}
	}
	sort.Strings(items)
	sum := sha256.Sum256([]byte(strings.Join(items, "|")))
	v.NetworkEpoch = hex.EncodeToString(sum[:])
	return v
}
func privateIPv4(ip net.IP) bool {
	v := ip.To4()
	return v != nil && (v[0] == 10 || (v[0] == 172 && v[1] >= 16 && v[1] <= 31) || (v[0] == 192 && v[1] == 168))
}
func validateSubnet(local, target, bcast string, prefix int) bool {
	if prefix < 1 || prefix > 30 {
		return false
	}
	a, b := net.ParseIP(local), net.ParseIP(target)
	if !privateIPv4(a) || !privateIPv4(b) {
		return false
	}
	mask := net.CIDRMask(prefix, 32)
	if !a.Mask(mask).Equal(b.Mask(mask)) {
		return false
	}
	expected := broadcast(a, mask)
	return expected != nil && *expected == bcast && target != bcast
}
func (l *LAN) localOK(id, address, epoch string, prefix int, bcast string) bool {
	v := l.Inventory()
	if epoch != v.NetworkEpoch {
		return false
	}
	for _, n := range v.Interfaces {
		if n.NativeID != id || !n.IsUp {
			continue
		}
		for _, a := range n.Addresses {
			if a.Address == address && a.PrefixLength == prefix && a.Broadcast != nil && *a.Broadcast == bcast {
				return true
			}
		}
	}
	return false
}
func MagicPacket(mac string) ([]byte, error) {
	address, err := net.ParseMAC(mac)
	if err != nil || len(address) != 6 || address[0]&1 != 0 || strings.ReplaceAll(mac, ":", "") == "000000000000" {
		return nil, errors.New("invalid MAC")
	}
	out := make([]byte, 102)
	for i := range 6 {
		out[i] = 255
	}
	for i := range 16 {
		copy(out[6+i*6:], address)
	}
	return out, nil
}
func udpWrite(local string, destination *net.UDPAddr, data []byte) error {
	socket, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP(local), Port: 0})
	if err != nil {
		return err
	}
	defer socket.Close()
	raw, err := socket.SyscallConn()
	if err != nil {
		return err
	}
	var sockErr error
	if err = raw.Control(func(fd uintptr) {
		sockErr = windows.SetsockoptInt(windows.Handle(fd), windows.SOL_SOCKET, windows.SO_BROADCAST, 1)
	}); err != nil {
		return err
	}
	if sockErr != nil {
		return sockErr
	}
	socket.SetWriteDeadline(time.Now().Add(time.Second))
	_, err = socket.WriteToUDP(data, destination)
	return err
}
func (l *LAN) emit(event map[string]any) {
	select {
	case l.Events <- event:
	case <-l.ctx.Done():
	default:
	}
}
func (l *LAN) mark(id string, expiry int64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now().UnixMilli()
	for key, until := range l.seen {
		if until < now {
			delete(l.seen, key)
		}
	}
	if _, ok := l.seen[id]; ok {
		return false
	}
	if len(l.seen) > 2048 {
		return false
	}
	l.seen[id] = expiry
	raw, err := json.Marshal(l.seen)
	if err != nil {
		return false
	}
	path := filepath.Join(l.cfg.StateDir, "commands.json")
	if os.WriteFile(path+".tmp", raw, 0600) != nil {
		return false
	}
	return os.Rename(path+".tmp", path) == nil
}
func (l *LAN) Execute(command ServerCommand) {
	now := time.Now().UnixMilli()
	result := func(status, reason string) {
		l.emit(map[string]any{"type": "command.result", "commandId": command.CommandID, "status": status, "reason": reason})
	}
	if command.ExpiresAt < now || command.ExpiresAt > now+30000 {
		if command.Action == "wake" {
			result("failed", "expired")
		}
		return
	}
	switch command.Action {
	case "wake":
		var p WolPayload
		if json.Unmarshal(command.Payload, &p) != nil || !validateSubnet(p.LocalAddress, p.TargetAddress, p.Broadcast, p.PrefixLength) {
			result("failed", "invalid_payload")
			return
		}
		packet, err := MagicPacket(p.MAC)
		if err != nil {
			result("failed", "invalid_payload")
			return
		}
		if !l.localOK(p.LocalInterfaceID, p.LocalAddress, p.NetworkEpoch, p.PrefixLength, p.Broadcast) {
			result("failed", "interface_changed")
			return
		}
		if !l.mark(command.CommandID, command.ExpiresAt) {
			result("failed", "duplicate")
			return
		}
		if udpWrite(p.LocalAddress, &net.UDPAddr{IP: net.ParseIP(p.Broadcast), Port: 9}, packet) != nil {
			result("failed", "udp_failed")
			return
		}
		result("packet_sent", "udp_sent")
	case "probe.listen", "probe.send":
		var p ProbePayload
		if json.Unmarshal(command.Payload, &p) != nil || p.TicketID != command.CommandID || !validateSubnet(p.LocalAddress, p.PeerAddress, p.Broadcast, p.PrefixLength) || !l.localOK(p.LocalInterfaceID, p.LocalAddress, p.NetworkEpoch, p.PrefixLength, p.Broadcast) {
			return
		}
		secret, err := base64.RawURLEncoding.DecodeString(p.Secret)
		if err != nil || len(secret) != 32 {
			return
		}
		l.mu.Lock()
		for id, probe := range l.probes {
			if probe.Deadline < now {
				delete(l.probes, id)
			}
		}
		if len(l.probes) >= 64 {
			l.mu.Unlock()
			return
		}
		record := &probe{Payload: p, Deadline: command.ExpiresAt, Initiator: command.Action == "probe.send"}
		l.probes[p.TicketID] = record
		l.mu.Unlock()
		if command.Action == "probe.listen" {
			l.emit(map[string]any{"type": "probe.ready", "ticketId": p.TicketID})
			return
		}
		go l.sendProbe(record)
	}
}
func proofText(d Datagram) string {
	return fmt.Sprintf("wakebridge|2|%s|%s|%s|%s|%s|%s", d.TicketID, d.From, d.To, d.Nonce, d.ResponseNonce, d.Kind)
}
func signDatagram(secret string, d Datagram) string {
	key, _ := base64.RawURLEncoding.DecodeString(secret)
	h := hmac.New(sha256.New, key)
	h.Write([]byte(proofText(d)))
	return hex.EncodeToString(h.Sum(nil))
}
func (l *LAN) proof(d Datagram) {
	l.emit(map[string]any{"type": "probe.proof", "ticketId": d.TicketID, "nonce": d.Nonce, "responseNonce": d.ResponseNonce, "signature": d.Signature})
}
func (l *LAN) sendProbe(record *probe) {
	p := record.Payload
	sock, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP(p.LocalAddress), Port: 0})
	if err != nil {
		return
	}
	defer sock.Close()
	raw, _ := sock.SyscallConn()
	if raw == nil {
		return
	}
	_ = raw.Control(func(fd uintptr) {
		_ = windows.SetsockoptInt(windows.Handle(fd), windows.SOL_SOCKET, windows.SO_BROADCAST, 1)
	})
	nonce := randomHex(16)
	l.mu.Lock()
	record.Nonce = nonce
	l.mu.Unlock()
	d := Datagram{Version: 2, Kind: "challenge", TicketID: p.TicketID, From: l.cfg.DeviceID, To: p.PeerDeviceID, Nonce: nonce}
	d.Signature = signDatagram(p.Secret, d)
	data, _ := json.Marshal(d)
	for range 3 {
		if time.Now().UnixMilli() > record.Deadline {
			return
		}
		if _, err = sock.WriteToUDP(data, &net.UDPAddr{IP: net.ParseIP(p.Broadcast), Port: DiscoveryPort}); err != nil {
			return
		}
		sock.SetReadDeadline(time.Now().Add(700 * time.Millisecond))
		buf := make([]byte, 2049)
		n, peer, readErr := sock.ReadFromUDP(buf)
		if readErr != nil {
			continue
		}
		if n > 2048 || peer.IP.String() != p.PeerAddress {
			continue
		}
		var reply Datagram
		if json.Unmarshal(buf[:n], &reply) != nil || reply.Kind != "reply" || reply.Nonce != nonce || reply.TicketID != p.TicketID || reply.From != p.PeerDeviceID || reply.To != l.cfg.DeviceID || reply.Version != 2 || len(reply.ResponseNonce) != 32 {
			continue
		}
		expected := signDatagram(p.Secret, reply)
		if hmac.Equal([]byte(expected), []byte(reply.Signature)) {
			l.proof(reply)
			return
		}
	}
}
func (l *LAN) receive() {
	buf := make([]byte, 2049)
	window := time.Now()
	count := 0
	for {
		l.socket.SetReadDeadline(time.Now().Add(time.Second))
		n, peer, err := l.socket.ReadFromUDP(buf)
		if err != nil {
			if l.ctx.Err() != nil {
				return
			}
			if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
				continue
			}
			return
		}
		if time.Since(window) > time.Second {
			window = time.Now()
			count = 0
		}
		count++
		if n > 2048 || count > 40 {
			continue
		}
		var d Datagram
		if json.Unmarshal(buf[:n], &d) != nil || d.Version != 2 || d.Kind != "challenge" || len(d.Nonce) != 32 || d.ResponseNonce != "" || d.To != l.cfg.DeviceID {
			continue
		}
		l.mu.Lock()
		record := l.probes[d.TicketID]
		if record == nil || record.Initiator || record.Used || record.Deadline < time.Now().UnixMilli() || record.Payload.PeerDeviceID != d.From || record.Payload.PeerAddress != peer.IP.String() {
			l.mu.Unlock()
			continue
		}
		p := record.Payload
		expected := signDatagram(p.Secret, d)
		if !hmac.Equal([]byte(expected), []byte(d.Signature)) {
			l.mu.Unlock()
			continue
		}
		record.Used = true
		l.mu.Unlock()
		if !l.localOK(p.LocalInterfaceID, p.LocalAddress, p.NetworkEpoch, p.PrefixLength, p.Broadcast) {
			continue
		}
		reply := Datagram{Version: 2, Kind: "reply", TicketID: d.TicketID, From: l.cfg.DeviceID, To: d.From, Nonce: d.Nonce, ResponseNonce: randomHex(16)}
		reply.Signature = signDatagram(p.Secret, reply)
		data, _ := json.Marshal(reply)
		if udpWrite(p.LocalAddress, peer, data) == nil {
			l.proof(reply)
		}
	}
}
