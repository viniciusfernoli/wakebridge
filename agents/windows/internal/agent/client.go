package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const Version = "0.2.0"

var ErrRevoked = errors.New("agent credential rejected; pair again")

type Config struct {
	Server     string `json:"server"`
	DeviceID   string `json:"deviceId"`
	Token      string `json:"token"`
	LANEnabled bool   `json:"lanEnabled"`
	StateDir   string `json:"-"`
}
type Address struct {
	Address      string  `json:"address"`
	PrefixLength int     `json:"prefixLength"`
	Broadcast    *string `json:"broadcast"`
}
type Network struct {
	NativeID   string    `json:"nativeId"`
	Name       string    `json:"name"`
	MAC        *string   `json:"mac"`
	Addresses  []Address `json:"addresses"`
	IsUp       bool      `json:"isUp"`
	WolSupport string    `json:"wolSupport"`
}
type Inventory struct {
	Hostname     string    `json:"hostname"`
	OSVersion    string    `json:"osVersion"`
	Architecture string    `json:"architecture"`
	AgentVersion string    `json:"agentVersion"`
	CPU          string    `json:"cpu"`
	MemoryBytes  uint64    `json:"memoryBytes"`
	Capabilities []string  `json:"capabilities"`
	Interfaces   []Network `json:"interfaces"`
	LANEnabled   bool      `json:"lanEnabled"`
	NetworkEpoch string    `json:"networkEpoch,omitempty"`
}

func ValidateServer(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("server must be an HTTPS origin")
	}
	loopback := u.Hostname() == "localhost"
	if ip := net.ParseIP(u.Hostname()); ip != nil {
		loopback = ip.IsLoopback()
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return "", errors.New("HTTPS required outside loopback")
	}
	return strings.TrimSuffix(u.String(), "/"), nil
}

var httpClient = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("redirects are not allowed") }}

func post(ctx context.Context, server, path, credential string, body, result any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", server+"/api/"+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if credential != "" {
		req.Header.Set("Authorization", "Bearer "+credential)
	}
	response, err := httpClient.Do(req)
	if err != nil {
		return errors.New("server unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode == 401 {
		return ErrRevoked
	}
	if response.StatusCode >= 300 {
		return fmt.Errorf("request rejected (%d)", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(result)
}

func Pair(ctx context.Context, server, name string, show func(code string)) (Config, error) {
	server, err := ValidateServer(server)
	if err != nil {
		return Config{}, err
	}
	var start struct {
		PairingID string    `json:"pairingId"`
		Secret    string    `json:"secret"`
		Code      string    `json:"code"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	if err = post(ctx, server, "pairing/start", "", map[string]string{"name": name, "platform": "windows"}, &start); err != nil {
		return Config{}, err
	}
	if start.PairingID == "" || start.Secret == "" || start.Code == "" {
		return Config{}, errors.New("invalid pairing response")
	}
	show(start.Code)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return Config{}, ctx.Err()
		case <-ticker.C:
		}
		if time.Now().After(start.ExpiresAt) {
			return Config{}, errors.New("pairing expired; try again")
		}
		var result struct {
			Status   string `json:"status"`
			DeviceID string `json:"deviceId"`
			Token    string `json:"token"`
		}
		err = post(ctx, server, "pairing/claim", "", map[string]string{"pairingId": start.PairingID, "secret": start.Secret}, &result)
		if err != nil {
			if errors.Is(err, ErrRevoked) {
				return Config{}, err
			}
			continue
		}
		if result.Status == "paired" && result.DeviceID != "" && strings.HasPrefix(result.Token, "wb_agent_") {
			return Config{Server: server, DeviceID: result.DeviceID, Token: result.Token}, nil
		}
	}
}

func Run(ctx context.Context, cfg Config, logger *log.Logger) error {
	if _, err := ValidateServer(cfg.Server); err != nil {
		return err
	}
	delay := time.Second
	var lan *LAN
	var inventorySalt = randomHex(16)
	if cfg.LANEnabled {
		var err error
		lan, err = NewLAN(ctx, cfg)
		if err != nil {
			logger.Print("LAN relay unavailable; check local UDP port and interface permissions")
		} else {
			defer lan.Close()
		}
	}
	for ctx.Err() == nil {
		connected, err := connect(ctx, cfg, logger, lan, inventorySalt)
		if errors.Is(err, ErrRevoked) {
			return err
		}
		if ctx.Err() != nil {
			return nil
		}
		if connected {
			delay = time.Second
		}
		logger.Print("Disconnected; reconnecting")
		wait := time.Duration(rand.Int64N(int64(delay)+1)) + delay/2
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
		delay = min(delay*2, 60*time.Second)
	}
	return nil
}

func connect(ctx context.Context, cfg Config, logger *log.Logger, lan *LAN, inventorySalt string) (bool, error) {
	u, _ := url.Parse(cfg.Server)
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/api/agent"
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, Proxy: http.ProxyFromEnvironment}
	conn, _, err := dialer.DialContext(ctx, u.String(), nil)
	if err != nil {
		return false, errors.New("connection unavailable")
	}
	defer conn.Close()
	stopped := make(chan struct{})
	defer close(stopped)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-stopped:
		}
	}()
	conn.SetReadLimit(65536)
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	getInventory := func() Inventory {
		if lan != nil {
			return lan.Inventory()
		}
		return withEpoch(CollectInventory(), inventorySalt)
	}
	if err = conn.WriteJSON(map[string]any{"type": "auth", "version": 2, "token": cfg.Token, "inventory": getInventory()}); err != nil {
		return false, err
	}
	var ready struct {
		Type        string `json:"type"`
		Version     int    `json:"version"`
		DeviceID    string `json:"deviceId"`
		SessionID   string `json:"sessionId"`
		HeartbeatMS int    `json:"heartbeatMs"`
	}
	if err = conn.ReadJSON(&ready); err != nil {
		var closeErr *websocket.CloseError
		if errors.As(err, &closeErr) && closeErr.Code == 1008 {
			return false, ErrRevoked
		}
		return false, err
	}
	if ready.Type != "ready" || ready.Version != 2 || ready.DeviceID != cfg.DeviceID || ready.SessionID == "" || ready.HeartbeatMS < 1000 || ready.HeartbeatMS > 30000 {
		return false, errors.New("invalid server handshake")
	}
	logger.Print("Connected and authenticated")
	readerErr := make(chan error, 1)
	commands := make(chan ServerCommand, 4)
	go func() {
		for {
			conn.SetReadDeadline(time.Now().Add(time.Duration(ready.HeartbeatMS*3) * time.Millisecond))
			var msg ServerCommand
			if readErr := conn.ReadJSON(&msg); readErr != nil {
				readerErr <- readErr
				return
			}
			if msg.Version != 2 || (msg.Type != "ack" && msg.Type != "command") {
				readerErr <- errors.New("unsupported server operation")
				conn.Close()
				return
			}
			if msg.Type == "command" {
				select {
				case commands <- msg:
				default:
					readerErr <- errors.New("command queue full")
					conn.Close()
					return
				}
			}
		}
	}()
	ticker := time.NewTicker(time.Duration(ready.HeartbeatMS) * time.Millisecond)
	defer ticker.Stop()
	seq := int64(0)
	var events <-chan map[string]any
	if lan != nil {
		events = lan.Events
	}
	write := func(msg map[string]any) error {
		seq++
		msg["version"] = 2
		msg["sessionId"] = ready.SessionID
		msg["seq"] = seq
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteJSON(msg)
	}
	for {
		select {
		case <-ctx.Done():
			return true, nil
		case err = <-readerErr:
			var closeErr *websocket.CloseError
			if errors.As(err, &closeErr) && closeErr.Code == 4000 && (closeErr.Text == "credential_revoked" || closeErr.Text == "credential_rotated") {
				return true, ErrRevoked
			}
			return true, err
		case <-ticker.C:
			msg := map[string]any{"type": "heartbeat"}
			if (seq+1)%12 == 0 {
				msg["type"] = "inventory"
				msg["inventory"] = getInventory()
			}
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err = write(msg); err != nil {
				return true, err
			}
		case command := <-commands:
			if command.SessionID != ready.SessionID {
				return true, errors.New("command session mismatch")
			}
			if lan != nil {
				lan.Execute(command)
			} else if command.Action == "wake" {
				if err = write(map[string]any{"type": "command.result", "commandId": command.CommandID, "status": "failed", "reason": "not_authorized"}); err != nil {
					return true, err
				}
			}
		case event := <-events:
			if err = write(event); err != nil {
				return true, err
			}
		}
	}
}
