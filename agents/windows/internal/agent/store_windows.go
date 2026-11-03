//go:build windows

package agent

import (
	"encoding/json"
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"unsafe"
)

func secureDir(dir string, service bool) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	sid, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	principal := sid.User.Sid.String()
	if service {
		principal = "LS"
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + principal + ")")
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}
func crypt(data []byte, protect, machine bool) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty credential")
	}
	in := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var out windows.DataBlob
	flags := uint32(windows.CRYPTPROTECT_UI_FORBIDDEN)
	if machine {
		flags |= windows.CRYPTPROTECT_LOCAL_MACHINE
	}
	var err error
	if protect {
		err = windows.CryptProtectData(&in, nil, nil, 0, nil, flags, &out)
	} else {
		err = windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	}
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}
func Save(dir string, cfg Config, serviceEnvelope bool) error {
	if err := secureDir(dir, serviceEnvelope); err != nil {
		return err
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	protected, err := crypt(raw, true, serviceEnvelope)
	if err != nil {
		return err
	}
	name := "agent.dpapi"
	if serviceEnvelope {
		name = "enrollment.dpapi"
	}
	path := filepath.Join(dir, name)
	tmp := path + ".tmp"
	if err = os.WriteFile(tmp, protected, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
func Load(dir string, service bool) (Config, error) {
	path := filepath.Join(dir, "agent.dpapi")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) && service {
		envelope, readErr := os.ReadFile(filepath.Join(dir, "enrollment.dpapi"))
		if readErr != nil {
			return Config{}, readErr
		}
		clear, readErr := crypt(envelope, false, false)
		if readErr != nil {
			return Config{}, readErr
		}
		var cfg Config
		if readErr = json.Unmarshal(clear, &cfg); readErr != nil {
			return Config{}, readErr
		}
		// The service rewraps the machine envelope using its own LocalService DPAPI identity.
		if readErr = Save(dir, cfg, false); readErr != nil {
			return Config{}, readErr
		}
		if readErr = os.Remove(filepath.Join(dir, "enrollment.dpapi")); readErr != nil {
			return Config{}, readErr
		}
		return cfg, nil
	}
	if err != nil {
		return Config{}, err
	}
	clear, err := crypt(raw, false, false)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	err = json.Unmarshal(clear, &cfg)
	return cfg, err
}
