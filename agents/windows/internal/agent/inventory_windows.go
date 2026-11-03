//go:build windows

package agent

import (
	"fmt"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"
	"unsafe"
)

func regString(path, name string) string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
	if err != nil {
		return "unknown"
	}
	defer k.Close()
	v, _, err := k.GetStringValue(name)
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(v)
}
func broadcast(ip net.IP, mask net.IPMask) *string {
	v := ip.To4()
	if v == nil || len(mask) != 4 {
		return nil
	}
	ones, bits := mask.Size()
	if bits != 32 || ones > 30 {
		return nil
	}
	out := make(net.IP, 4)
	for i := range 4 {
		out[i] = v[i] | ^mask[i]
	}
	s := out.String()
	return &s
}

// Adapter GUIDs survive interface-index changes across boots and driver updates.
func adapterIDs() map[int]string {
	result := make(map[int]string)
	size := uint32(15000)
	for range 3 {
		buffer := make([]byte, size)
		first := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buffer[0]))
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, 0, 0, first, &size)
		if err == windows.ERROR_BUFFER_OVERFLOW {
			continue
		}
		if err != nil {
			return result
		}
		for adapter := first; adapter != nil; adapter = adapter.Next {
			result[int(adapter.IfIndex)] = windows.BytePtrToString(adapter.AdapterName)
		}
		return result
	}
	return result
}
func windowsDisplayName(product,build string)string {number,err:=strconv.Atoi(build);if err==nil&&number>=22000&&strings.HasPrefix(product,"Windows 10"){return strings.Replace(product,"Windows 10","Windows 11",1)};return product}
func CollectInventory() Inventory {
	host, _ := os.Hostname()
	if host == "" {
		host = "Windows"
	}
	product:=regString(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`,"ProductName");build:=regString(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`,"CurrentBuild")
	i := Inventory{Hostname: host, OSVersion: windowsDisplayName(product,build)+" (build "+build+")", Architecture: runtime.GOARCH, AgentVersion: Version, CPU: regString(`HARDWARE\DESCRIPTION\System\CentralProcessor\0`, "ProcessorNameString"), Capabilities: []string{"inventory"}, Interfaces: []Network{}}
	var mem struct {
		Length        uint32
		Load          uint32
		TotalPhys     uint64
		AvailPhys     uint64
		TotalPage     uint64
		AvailPage     uint64
		TotalVirtual  uint64
		AvailVirtual  uint64
		AvailExtended uint64
	}
	mem.Length = uint32(unsafe.Sizeof(mem))
	proc := windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")
	ok, _, _ := proc.Call(uintptr(unsafe.Pointer(&mem)))
	if ok != 0 {
		i.MemoryBytes = mem.TotalPhys
	}
	interfaces, _ := net.Interfaces()
	identities := adapterIDs()
	for _, n := range interfaces {
		if n.Flags&net.FlagLoopback != 0 {
			continue
		}
		identity := identities[n.Index]
		if identity == "" {
			identity = fmt.Sprintf("fallback:%s:%s", n.Name, n.HardwareAddr.String())
		}
		entry := Network{NativeID: identity, Name: n.Name, Addresses: []Address{}, IsUp: n.Flags&net.FlagUp != 0, WolSupport: "unknown"}
		if len(n.HardwareAddr) == 6 {
			s := strings.ToUpper(n.HardwareAddr.String())
			entry.MAC = &s
		}
		addrs, _ := n.Addrs()
		for _, a := range addrs {
			ip, network, err := net.ParseCIDR(a.String())
			if err != nil || ip.To4() == nil {
				continue
			}
			ones, _ := network.Mask.Size()
			entry.Addresses = append(entry.Addresses, Address{ip.String(), ones, broadcast(ip, network.Mask)})
		}
		if len(entry.Addresses) > 16 {
			entry.Addresses = entry.Addresses[:16]
		}
		if len(i.Interfaces) < 32 {
			i.Interfaces = append(i.Interfaces, entry)
		}
	}
	return i
}
