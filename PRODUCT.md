# WakeBridge

<!-- impeccable:product-schema 1 -->

## Platform
web

The control panel is responsive web/PWA. The first managed client is a native Windows service; native Android/TV follows in the next approved phase.

## Stack
User requested Next.js App Router, Tailwind, shadcn/ui, Lucide, NestJS, Prisma/PostgreSQL, Go, Kotlin, Docker Compose and Caddy. Approved on 2026-11-03. User subsequently authorized npm; implementation uses npm workspaces + Turborepo and a single package-lock.json.

## Users
People managing their own computers from another network, including a phone on mobile data. Installation must feel like an ordinary application.

## Product Purpose
Secure self-hosted device management using outbound connections and authorized local Wake-on-LAN relays, without router port forwarding or a VPN.

## Capabilities and Constraints
Never equate offline with powered off, or packet transmission with successful wake. Retain device inventory offline. Separate user sessions and agent identities. No remote shell. Isolate workspaces. No fabricated device data. Android availability depends on operating system and hardware restrictions.

## Brand Commitments
The user approved WakeBridge as the working project name. Portuguese interface; modern, calm, accessible, light/dark, usable on mobile.

## Evidence on Hand
Windows and Android/TV agent code, actual UDP packet emission, authenticated discovery, durable relay orchestration and integrated dashboard controls are implemented. Native Windows broadcast was captured in tests; Android JVM UDP tests and APK builds passed. No physical Android TV standby or real S5 boot evidence exists yet. See docs/phase2-validation.md for the verification boundary.

## Product Principles
- Show evidence and uncertainty clearly.
- Keep installation and daily control simple.
- Persist identity and inventory independently of connectivity.
- Least privilege and explicit remote operations.

## Accessibility & Inclusion
Keyboard support, visible focus, adequate contrast, reduced motion, mobile layouts. Android D-pad support belongs to the next phase.
