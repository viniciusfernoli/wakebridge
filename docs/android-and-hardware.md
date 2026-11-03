# Android / Android TV and physical acceptance

The native APK supports Android 8+ (API 26), including phone and TV launcher entry points, no touchscreen requirement, normal focusable Material controls and D-pad navigation. The build uses AGP 9.5.0, Gradle 9.6.0, JDK 21 and the stable SDK package `platforms;android-37.0` (API 37). Versions and archives were checked against Google/Gradle sources before use.

## Build

On Windows, using project-local SDK/Gradle:

```powershell
.\scripts\setup-android.ps1
.\scripts\build-android.ps1
```

Output: `.local/android/app-debug.apk` and the clearly labeled debug download in the dashboard. The official Gradle wrapper and its distribution checksum are committed. On another OS, install JDK 21 and Android SDK API 37/build-tools 36.0.0, set ANDROID_HOME, then run `./gradlew testDebugUnitTest lintDebug assembleDebug` in `apps/agent-android`. Docker builds compile/test the APK from source too; no prebuilt APK or private key is committed.

For a signed release, create/keep a keystore OUTSIDE the repository. For example, use `keytool -genkeypair -keystore <secure-path> -alias wakebridge -keyalg RSA -keysize 3072 -validity 10000` and enter passwords interactively. Set these process environment variables through your secret-management mechanism, never in a tracked file or shared shell log:

- WAKEBRIDGE_KEYSTORE (absolute path)
- WAKEBRIDGE_STORE_PASSWORD
- WAKEBRIDGE_KEY_ALIAS
- WAKEBRIDGE_KEY_PASSWORD

Then `./scripts/build-android.ps1 -Release`, or `./gradlew assembleRelease` with those same variables. The Windows script refuses a release without a keystore; release is minified and resource-shrunk. The debug APK uses a development signing identity. Android correctly refuses an update with a different signing key; a fresh install/re-pair may be needed when switching from debug to your release key. Unsigned or externally signed release builds are not described as production-distributed artifacts here.

## Pair and authorize

1. Install the APK (sideload if necessary), open WakeBridge, enter the HTTPS server origin and a recognizable device name. Generate its temporary code.
2. In the dashboard's **Adicionar dispositivo**, inspect that name and approve the code. The agent obtains an exclusive credential stored with Android Keystore AES-GCM; the user session is never copied to the APK. Backups/transfers exclude its credential storage.
3. Enable **Autorizar descoberta e pacotes WoL nesta LAN**. On Android 17+, grant ACCESS_LOCAL_NETWORK when requested; denial leaves LAN disabled. Enable notifications if desired. The service uses `connectedDevice`, an ongoing notification and a stop action. These conform to [foreground-service prerequisites](https://developer.android.com/develop/background-work/services/fgs/service-types#connected-device) and [local-network permissions](https://developer.android.com/privacy-and-security/local-network-permission).
4. In dashboard device details, **Autorizar como relé**. Do the same local LAN opt-in and owner approval on the Windows peer (`--lan` / `-EnableLanRelay`). Keep both online for authenticated discovery.
5. Confirm a verified network/link. If Wi-Fi isolation/broadcast filtering prevents proof, use the manual interface-selection flow. Its label remains manual and a dispatch test never proves boot.

The elevated Windows installer creates its own program/service-scoped UDP 34780 inbound firewall rule only with `-EnableLanRelay`, only for Private/Domain profiles and LocalSubnet peers. It does not open the Public profile or a router port. The uninstaller removes that named rule. Console mode cannot modify firewall policy without elevation; allow only this application's authenticated discovery on an appropriate trusted profile when needed. This installer/firewall path was not executed in the non-elevated development terminal.

Release accepts HTTPS/WSS with normal certificate validation. Debug also permits only localhost/127.0.0.1 and Android emulator host 10.0.2.2 over HTTP for local development; it does not permit arbitrary LAN cleartext or trust all certificates. A physical BTV therefore needs a valid HTTPS deployment; it needs no inbound router ports, public home IP, DDNS or VPN.

## BTV B13: test each layer separately

No Android device was connected over ADB during implementation, so this checklist is a physical acceptance procedure, not claimed evidence.

| Layer             | Procedure                                                                                                          | Evidence to record                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Install           | Sideload the debug APK or `adb -s <approved-serial> install -r <apk>` on your own test BTV. Open from TV launcher. | Model, firmware/API level, installed version; no root required.                                                                |
| D-pad             | Use only the remote to focus every field, toggle and button; type server/name, generate a code.                    | Visible focus, readable code, usable Back; no hidden touch dependency.                                                         |
| Service           | Pair and start; open Home and return. Test both app Stop and notification Stop.                                    | Online/Offline transitions, notification/task-manager indicator as allowed by the OS.                                          |
| Credential        | Stop/start without re-pairing; revoke in dashboard and attempt reconnect.                                          | Same identity before revocation; rejection afterwards. Never capture token plaintext in logs.                                  |
| Boot              | Enable the opt-in boot attempt; reboot and unlock if the firmware requires it.                                     | Service reconnect or an explicit OEM/Android restriction. A BOOT_COMPLETED attempt is not a guarantee.                         |
| Network           | Toggle Wi-Fi/Ethernet and restore it; test an actual network change.                                               | Backoff/reconnect, new epoch, old link invalidation and a fresh verified/manual link.                                          |
| Local UDP         | Keep Windows online; authorize both agents, run discovery and a relay emission test.                               | Both independent proofs, selected interface, packet report. Capture UDP 9 on a suitable local test host if available.          |
| WoL Android relay | Configure BIOS/NIC, disconnect the Windows agent by actual shutdown, then request wake over mobile data.           | Android selected, packet sent, WAITING, real PC boot and agent reconnection → ONLINE. Record power state and timings.          |
| WoL Windows relay | Repeat with a second physical Windows computer as the only online relay.                                           | Actual UDP from Windows relay, real boot/reconnection.                                                                         |
| Failover          | Keep two proven relays online; interrupt the first relay and request wake.                                         | Bounded alternate attempt and full operation history; no duplicate same-attempt execution.                                     |
| Standby           | Repeat after TV-off, remote standby and idle intervals of 15/60 minutes.                                           | Whether this firmware keeps CPU/network active. If not, the dashboard must show unavailable; no workaround or always-on claim. |

For the Windows target, enable the manufacturer's Wake-on-LAN/PCIe wake options in BIOS/UEFI and supported NIC driver settings. Verify its actual MAC and wired interface; Wi-Fi, USB adapters and S5 support vary. Evaluate Windows Fast Startup, ErP/deep-sleep and physical power state according to that hardware's documentation. First prove a local manual wake before testing the internet-controlled relay path. Inventory continues to say hardware WoL support unknown until physical evidence exists.

The system cannot emit a LAN packet if every relay is offline or asleep. It explains unavailable relays and preserves the PC inventory. Do not classify an absent heartbeat as a proven shutdown, or an emitted packet as a successful wake.
