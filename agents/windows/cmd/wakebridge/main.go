//go:build windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/wakebridge/wakebridge/agents/windows/internal/agent"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"
)

const serviceName = "WakeBridge"

type service struct{ dir string }

func (s *service) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	cfg, err := agent.Load(s.dir, true)
	if err != nil {
		return true, 1
	}
	cfg.StateDir = s.dir
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	file, err := os.OpenFile(filepath.Join(s.dir, "agent.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return true, 2
	}
	defer file.Close()
	done := make(chan error, 1)
	go func() { done <- agent.Run(ctx, cfg, log.New(file, "", log.LstdFlags)) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case <-done:
			return true, 3
		case change := <-requests:
			switch change.Cmd {
			case svc.Interrogate:
				status <- change.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case <-done:
				case <-time.After(15 * time.Second):
				}
				return false, 0
			}
		}
	}
}
func install(dir string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	s, err := m.CreateService(serviceName, exe, mgr.Config{DisplayName: "WakeBridge Agent", Description: "Authenticated outbound device inventory connection", StartType: mgr.StartAutomatic, ServiceStartName: `NT AUTHORITY\LocalService`}, "service", "--config-dir", dir)
	if err != nil {
		return err
	}
	defer s.Close()
	return s.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 15 * time.Second}, {Type: mgr.ServiceRestart, Delay: 60 * time.Second}}, 86400)
}
func uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer s.Close()
	_, _ = s.Control(svc.Stop)
	for range 30 {
		state, e := s.Query()
		if e != nil || state.State == svc.Stopped {
			break
		}
		time.Sleep(time.Second)
	}
	return s.Delete()
}
func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
func run() error {
	command := "run"
	args := os.Args[1:]
	if len(args) > 0 {
		command = args[0]
		args = args[1:]
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	server := flags.String("server", "", "HTTPS server origin")
	name, _ := os.Hostname()
	deviceName := flags.String("name", name, "device name")
	configDir := flags.String("config-dir", filepath.Join(os.Getenv("LOCALAPPDATA"), "WakeBridge"), "credential directory")
	serviceEnrollment := flags.Bool("service", false, "prepare restricted LocalService enrollment")
	lanEnabled := flags.Bool("lan", false, "allow discovery and UDP Wake-on-LAN on connected private interfaces")
	if err := flags.Parse(args); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	switch command {
	case "version":
		fmt.Println(agent.Version)
		return nil
	case "inventory":
		return json.NewEncoder(os.Stdout).Encode(agent.CollectInventory())
	case "install":
		return install(*configDir)
	case "uninstall":
		return uninstall()
	case "service":
		return svc.Run(serviceName, &service{dir: *configDir})
	case "pair":
		if *server == "" {
			fmt.Print("Server HTTPS URL: ")
			scanner := bufio.NewScanner(os.Stdin)
			if scanner.Scan() {
				*server = strings.TrimSpace(scanner.Text())
			}
		}
		cfg, err := agent.Pair(ctx, *server, *deviceName, func(code string) {
			fmt.Printf("Pairing code: %s\nOpen %s and authorize this computer. Code expires in five minutes.\n", code, *server)
		})
		if err != nil {
			return err
		}
		cfg.LANEnabled = *lanEnabled
		cfg.StateDir = *configDir
		if err = agent.Save(*configDir, cfg, *serviceEnrollment); err != nil {
			return err
		}
		if *serviceEnrollment {
			fmt.Println("Enrollment saved for the Windows service.")
			return nil
		}
		return agent.Run(ctx, cfg, log.New(os.Stderr, "", log.LstdFlags))
	case "run":
		cfg, err := agent.Load(*configDir, false)
		if err != nil {
			return fmt.Errorf("pair first: wakebridge.exe pair --server https://your-server")
		}
		cfg.StateDir = *configDir
		flags.Visit(func(f *flag.Flag) {
			if f.Name == "lan" {
				cfg.LANEnabled = *lanEnabled
			}
		})
		return agent.Run(ctx, cfg, log.New(os.Stderr, "", log.LstdFlags))
	default:
		return fmt.Errorf("supported commands: pair, run, service, install, uninstall, inventory, version")
	}
}
