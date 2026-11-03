//go:build windows

package agent

import (
	"encoding/hex"
	"fmt"
	"golang.org/x/sys/windows"
	"net"
	"sort"
	"strings"
	"unsafe"
)

// Read only the OS neighbour cache and configured gateways; never scan or ARP-sweep.
func gatewayFingerprint() string {
	type row struct {
		Luid           uint64
		Index          uint32
		Address        [28]byte
		Physical       [32]byte
		PhysicalLength uint32
		State          uint32
		Flags          uint8
		Padding        [3]byte
		Reachable      uint32
	}
	neighbours := map[string]string{}
	var table *byte
	dll := windows.NewLazySystemDLL("iphlpapi.dll")
	result, _, _ := dll.NewProc("GetIpNetTable2").Call(windows.AF_INET, uintptr(unsafe.Pointer(&table)))
	if result == 0 && table != nil {
		defer dll.NewProc("FreeMibTable").Call(uintptr(unsafe.Pointer(table)))
		count := *(*uint32)(unsafe.Pointer(table))
		if count <= 4096 {
			for i := uint32(0); i < count; i++ {
				item := (*row)(unsafe.Add(unsafe.Pointer(table), 8+uintptr(i)*unsafe.Sizeof(row{})))
				if item.PhysicalLength == 6 {
					ip := net.IPv4(item.Address[4], item.Address[5], item.Address[6], item.Address[7])
					neighbours[fmt.Sprintf("%d:%s", item.Index, ip.String())] = hex.EncodeToString(item.Physical[:6])
				}
			}
		}
	}
	size := uint32(16000)
	items := []string{}
	for range 3 {
		buffer := make([]byte, size)
		first := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buffer[0]))
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, windows.GAA_FLAG_INCLUDE_GATEWAYS, 0, first, &size)
		if err == windows.ERROR_BUFFER_OVERFLOW {
			continue
		}
		if err != nil {
			break
		}
		for adapter := first; adapter != nil; adapter = adapter.Next {
			for gateway := adapter.FirstGatewayAddress; gateway != nil; gateway = gateway.Next {
				if gateway.Address.Sockaddr != nil && gateway.Address.Sockaddr.Addr.Family == windows.AF_INET {
					address := (*windows.RawSockaddrInet4)(unsafe.Pointer(gateway.Address.Sockaddr))
					ip := net.IP(address.Addr[:]).String()
					key := fmt.Sprintf("%d:%s", adapter.IfIndex, ip)
					items = append(items, key+":"+neighbours[key])
				}
			}
		}
		break
	}
	sort.Strings(items)
	return strings.Join(items, "|")
}
