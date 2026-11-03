"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  House,
  Laptop,
  Link2,
  LoaderCircle,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Radio,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Unplug,
  X,
} from "lucide-react";
import type { DeviceView } from "@wakebridge/shared";
import { Button } from "./ui/button";
import { api, ApiError } from "@/lib/api";
import { RelayControls, Operations, Networks } from "./relay-controls";

type Me = {
  id: string;
  name: string;
  email: string;
  workspaces: { id: string; name: string; role: string; canWake: boolean }[];
};
type Audit = {
  id: string;
  action: string;
  targetId: string | null;
  createdAt: string;
};
const messages: Record<string, string> = {
  "pairing.approved": "Vínculo de dispositivo autorizado",
  "device.paired": "Dispositivo vinculado",
  "device.revoked": "Acesso do dispositivo revogado",
  "credential.rotated": "Credencial do agente rotacionada",
  "relay.approved": "Agente autorizado como relé",
  "relay.disabled": "Uso como relé desautorizado",
  "relay.manual_authorized": "Vínculo de relé autorizado manualmente",
  "wake.requested": "Solicitação para ligar um computador",
  "relay.test_requested": "Teste de emissão Wake-on-LAN solicitado",
};
function date(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(value))
    : "Ainda sem contato";
}

function Auth({ onSuccess }: { onSuccess: () => void }) {
  const [register, setRegister] = useState(false);
  const mutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api(`auth/${register ? "register" : "login"}`, body),
    onSuccess,
  });
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Brand />
        <div>
          <h1>
            Seus dispositivos.
            <br />
            <span>Sempre por perto.</span>
          </h1>
          <p>
            Um espaço seguro para acompanhar seus computadores, de onde você
            estiver.
          </p>
          <div className="story-connection">
            <Monitor size={36} />
            <span className="connection-line" />
            <ShieldCheck size={30} />
            <span className="connection-line" />
            <Laptop size={36} />
          </div>
        </div>
        <p className="story-footer">
          Open-source. Self-hosted. Sob seu controle.
        </p>
      </section>
      <section className="auth-form-wrap">
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate(
              Object.fromEntries(new FormData(e.currentTarget)) as Record<
                string,
                string
              >,
            );
          }}
        >
          <div className="auth-mobile-brand">
            <Brand />
          </div>
          <h2>
            {register ? "Seu espaço começa aqui" : "Bom ter você de volta"}
          </h2>
          <p>
            {register
              ? "Crie sua conta para conectar o primeiro computador."
              : "Entre para acompanhar seus dispositivos."}
          </p>
          {register && (
            <>
              <label>
                Seu nome
                <input
                  name="name"
                  autoComplete="name"
                  minLength={2}
                  maxLength={80}
                  required
                  placeholder="Como podemos chamar você?"
                />
              </label>
              <label>
                Nome do espaço
                <input
                  name="workspaceName"
                  minLength={2}
                  maxLength={80}
                  required
                  placeholder="Minha casa"
                />
              </label>
            </>
          )}
          <label>
            E-mail
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="voce@exemplo.com"
            />
          </label>
          <label>
            Senha
            <input
              name="password"
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              minLength={12}
              maxLength={128}
              required
              placeholder="Pelo menos 12 caracteres"
            />
          </label>
          {mutation.error && (
            <p className="error" role="alert">
              {mutation.error.message}
            </p>
          )}
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <>
                {register ? "Criar meu espaço" : "Entrar no meu espaço"}
                <ArrowRight size={18} />
              </>
            )}
          </Button>
          <div className="auth-switch">
            {register ? "Já tem uma conta?" : "Primeira vez aqui?"}{" "}
            <button
              type="button"
              onClick={() => {
                setRegister(!register);
                mutation.reset();
              }}
            >
              {register ? "Entrar" : "Criar conta"}
            </button>
          </div>
          <p className="auth-note">
            <ShieldCheck size={16} /> Suas credenciais ficam nesta instalação.
          </p>
        </form>
      </section>
    </main>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-symbol">
        <Link2 size={22} />
      </span>
      WakeBridge<span className="brand-dot">.</span>
    </div>
  );
}

export function Dashboard() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("auth/me") });
  const [workspace, setWorkspace] = useState("");
  const [page, setPage] = useState("overview");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { resolvedTheme, setTheme } = useTheme();
  const active =
    me.data?.workspaces.find((w) => w.id === workspace) ??
    me.data?.workspaces[0];
  const workspaceId = active?.id;
  const devices = useQuery({
    queryKey: ["devices", workspaceId],
    queryFn: () => api<DeviceView[]>(`workspaces/${workspaceId}/devices`),
    enabled: !!workspaceId,
    refetchInterval: 10000,
  });
  const history = useQuery({
    queryKey: ["history", workspaceId],
    queryFn: () => api<Audit[]>(`workspaces/${workspaceId}/history`),
    enabled: !!workspaceId,
    refetchInterval: 15000,
  });
  const logout = useMutation({
    mutationFn: () => api("auth/logout", {}),
    onSuccess: () => {
      client.clear();
      location.reload();
    },
  });
  useEffect(() => {
    if (!me.data) return;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`,
      );
      socket.onmessage = (e) => {
        const event = JSON.parse(e.data);
        if (event.type === "devices.changed") {
          void client.invalidateQueries({
            queryKey: ["devices", event.workspaceId],
          });
          void client.invalidateQueries({
            queryKey: ["history", event.workspaceId],
          });
          void client.invalidateQueries({
            queryKey: ["operations", event.workspaceId],
          });
          void client.invalidateQueries({
            queryKey: ["relays", event.workspaceId],
          });
          void client.invalidateQueries({
            queryKey: ["networks", event.workspaceId],
          });
        }
      };
      socket.onclose = () => {
        if (!stopped) timer = setTimeout(connect, 3000 + Math.random() * 2000);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [me.data, client]);
  useEffect(() => {
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker.register("/sw.js");
  }, []);
  if (me.isPending)
    return (
      <main className="initial-loading">
        <Brand />
        <LoaderCircle className="spin" />
        <span>Conectando ao seu espaço…</span>
      </main>
    );
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401)
      return (
        <Auth
          onSuccess={() => {
            client.clear();
            location.reload();
          }}
        />
      );
    return (
      <main className="initial-loading">
        <Brand />
        <p role="alert">Não foi possível acessar o servidor.</p>
        <Button onClick={() => void me.refetch()}>Tentar novamente</Button>
      </main>
    );
  }
  const list = devices.data ?? [];
  const online = list.filter((d) => d.status === "online").length;
  const visible = list.filter(
    (d) =>
      `${d.name} ${d.hostname ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" || d.status === filter),
  );
  const current = list.find((d) => d.id === selected);
  const nav = [
    { id: "overview", icon: House, label: "Visão geral" },
    { id: "devices", icon: Monitor, label: "Dispositivos" },
    { id: "networks", icon: Radio, label: "Redes e relés" },
    { id: "history", icon: Clock3, label: "Atividade" },
    { id: "settings", icon: Settings2, label: "Configurações" },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <label className="workspace-label">
          Seu espaço
          <select
            aria-label="Selecionar espaço"
            value={workspaceId ?? ""}
            onChange={(e) => {
              setWorkspace(e.target.value);
              setSelected(null);
              setAdding(false);
            }}
          >
            {me.data?.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Navegação principal">
          {nav.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "nav-item active" : "nav-item"}
              onClick={() => {
                setPage(n.id);
                setAdding(false);
                setSelected(null);
              }}
            >
              <n.icon size={19} />
              {n.label}
              {page === n.id && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <ShieldCheck size={20} />
            <div>
              <strong>Seu servidor. Seus dados.</strong>
              <p>Conexões de saída seguras.</p>
            </div>
          </div>
          <button
            className="theme-switch"
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            <Sun size={17} />
            <span>Alternar aparência</span>
            <Moon size={16} />
          </button>
          <div className="profile">
            <span className="avatar">
              {me.data?.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{me.data?.name}</strong>
              <span>
                {active?.role === "OWNER" ? "Administrador" : "Membro"}
              </span>
            </div>
            <button
              aria-label="Sair da conta"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              <LogOut size={18} />
            </button>
          </div>
          {logout.error && (
            <p className="error" role="alert">
              {logout.error.message}
            </p>
          )}
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <span>
            {active?.name}
            <ChevronRight size={14} />
            <strong>{nav.find((n) => n.id === page)?.label}</strong>
          </span>
          <span className="private-label">
            <ShieldCheck size={14} /> Espaço privado
          </span>
        </header>
        <main className="content">
          <div className="page-heading">
            <div>
              <h1>
                {page === "history"
                  ? "Tudo o que aconteceu."
                  : page === "networks"
                    ? "Redes e relés."
                    : page === "settings"
                      ? "Do seu jeito."
                      : "Seus dispositivos, por perto."}
              </h1>
              <p>
                {page === "history"
                  ? "Vínculos e mudanças de acesso registrados neste espaço."
                  : page === "networks"
                    ? "Conexões locais verificadas e agentes que podem ajudar."
                    : page === "settings"
                      ? "Sua conta e o espaço que reúne seus computadores."
                      : "Acompanhe suas conexões. Tudo em um só lugar."}
              </p>
            </div>
            {["overview", "devices"].includes(page) &&
              active?.role === "OWNER" && (
                <Button
                  onClick={() => {
                    setAdding(!adding);
                    setSelected(null);
                  }}
                >
                  <Plus size={18} />
                  Adicionar dispositivo
                </Button>
              )}
          </div>
          {adding && workspaceId && (
            <Pairing
              workspaceId={workspaceId}
              onClose={() => setAdding(false)}
            />
          )}
          {page === "settings" ? (
            <section className="settings-surface">
              <h2>Sua conta</h2>
              <dl>
                <dt>Nome</dt>
                <dd>{me.data?.name}</dd>
                <dt>E-mail</dt>
                <dd>{me.data?.email}</dd>
                <dt>Espaço</dt>
                <dd>{active?.name}</dd>
                <dt>Permissão</dt>
                <dd>
                  {active?.role === "OWNER"
                    ? "Administrador — pode vincular e revogar agentes"
                    : "Membro — consulte as permissões com o administrador"}
                </dd>
              </dl>
              <p className="muted">
                Cada agente tem sua própria credencial. Para retirar o acesso de
                um computador, abra os detalhes do dispositivo.
              </p>
              <div className="settings-actions">
                <Button
                  variant="outline"
                  onClick={() =>
                    setTheme(resolvedTheme === "dark" ? "light" : "dark")
                  }
                >
                  <Sun size={16} />
                  Alternar aparência
                </Button>
                <Button
                  variant="outline"
                  onClick={() => logout.mutate()}
                  disabled={logout.isPending}
                >
                  <LogOut size={16} />
                  Sair da conta
                </Button>
              </div>
            </section>
          ) : page === "networks" && workspaceId ? (
            <Networks
              workspaceId={workspaceId}
              canManage={active?.role === "OWNER"}
            />
          ) : page === "history" ? (
            <section>
              {workspaceId && <Operations workspaceId={workspaceId} />}
              <h2>Autorizações e vínculos</h2>
              <ActivityList data={history.data} error={history.error} />
            </section>
          ) : (
            <>
              <section
                className="connection-summary"
                aria-label="Resumo das conexões"
              >
                <div>
                  <span className="status-indicator online" />
                  <strong>{online}</strong>
                  <span>
                    {online === 1
                      ? "dispositivo online"
                      : "dispositivos online"}
                  </span>
                </div>
                <span className="summary-separator" />
                <div>
                  <Monitor size={17} />
                  <strong>{list.length}</strong>
                  <span>{list.length === 1 ? "vinculado" : "vinculados"}</span>
                </div>
                <p>
                  <Radio size={15} /> Status atualizado automaticamente
                </p>
              </section>
              <div className={current ? "main-grid has-detail" : "main-grid"}>
                <section className="inventory-surface">
                  <div className="section-heading">
                    <h2>
                      Dispositivos <span>{list.length}</span>
                    </h2>
                    <label className="search-box">
                      <Search size={17} />
                      <input
                        aria-label="Buscar dispositivo"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Buscar dispositivo"
                      />
                    </label>
                  </div>
                  <div
                    className="filter-tabs"
                    role="group"
                    aria-label="Filtrar dispositivos"
                  >
                    {[
                      { id: "all", label: "Todos" },
                      { id: "online", label: "Online" },
                      { id: "offline", label: "Offline" },
                    ].map((f) => (
                      <button
                        key={f.id}
                        aria-pressed={filter === f.id}
                        className={filter === f.id ? "selected" : ""}
                        onClick={() => setFilter(f.id)}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  {devices.isPending ? (
                    <div
                      className="skeleton-list"
                      aria-label="Carregando dispositivos"
                    >
                      {[1, 2, 3].map((n) => (
                        <div className="skeleton" key={n} />
                      ))}
                    </div>
                  ) : devices.error ? (
                    <div className="empty">
                      <Unplug size={30} />
                      <h3>Sem conexão com o servidor</h3>
                      <p>{devices.error.message}</p>
                      <Button
                        variant="outline"
                        onClick={() => void devices.refetch()}
                      >
                        Tentar novamente
                      </Button>
                    </div>
                  ) : !visible.length ? (
                    <div className="empty">
                      <span className="empty-symbol">
                        <Monitor size={36} />
                        <span className="small-plus">
                          <Plus size={14} />
                        </span>
                      </span>
                      <h3>
                        {list.length
                          ? "Nenhum dispositivo encontrado"
                          : "Seu primeiro computador começa aqui"}
                      </h3>
                      <p>
                        {list.length
                          ? "Tente outro nome ou filtro para encontrar o dispositivo."
                          : "Instale o agente Windows e vincule o código ao seu espaço. O inventário aparece assim que ele se conecta."}
                      </p>
                      {!list.length && active?.role === "OWNER" && (
                        <Button
                          variant="outline"
                          onClick={() => setAdding(true)}
                        >
                          Conectar meu computador
                          <ArrowRight size={16} />
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="device-list">
                      {visible.map((d) => (
                        <button
                          className={`device-row ${selected === d.id ? "selected" : ""}`}
                          key={d.id}
                          onClick={() =>
                            setSelected(selected === d.id ? null : d.id)
                          }
                        >
                          <span className="device-icon">
                            <Monitor size={26} />
                            <span className={`status-indicator ${d.status}`} />
                          </span>
                          <span className="device-description">
                            <strong>{d.name}</strong>
                            <span>
                              {d.osVersion ?? "Windows"} ·{" "}
                              {d.hostname ?? "Aguardando inventário"}
                            </span>
                          </span>
                          <span className={`status-badge ${d.status}`}>
                            <span className={`status-indicator ${d.status}`} />
                            {d.status === "online"
                              ? "Online"
                              : d.status === "offline"
                                ? "Offline"
                                : "Aguardando"}
                          </span>
                          <ChevronRight size={18} className="row-chevron" />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="inventory-footnote">
                    <CircleHelp size={15} />
                    <span>
                      Offline indica ausência de conexão, sem confirmar se o
                      computador está desligado.
                    </span>
                  </div>
                </section>
                {current && workspaceId ? (
                  <DeviceDetails
                    device={current}
                    workspaceId={workspaceId}
                    canManage={active?.role === "OWNER"}
                    canWake={active?.canWake ?? false}
                    onClose={() => setSelected(null)}
                  />
                ) : (
                  <aside className="connection-guide">
                    <div className="guide-top">
                      <span className="guide-icon">
                        <Link2 size={24} />
                      </span>
                      <span>Uma conexão de confiança</span>
                    </div>
                    <h2>
                      Seu computador.
                      <br />
                      No seu espaço.
                    </h2>
                    <p>
                      O agente se conecta ao seu servidor e mantém as
                      informações do dispositivo atualizadas.
                    </p>
                    <ol>
                      <li>
                        <span>1</span>
                        <div>
                          <strong>Instale o agente</strong>
                          <p>Um executável nativo para Windows.</p>
                        </div>
                      </li>
                      <li>
                        <span>2</span>
                        <div>
                          <strong>Autorize o vínculo</strong>
                          <p>Confira o código e o nome do computador.</p>
                        </div>
                      </li>
                      <li>
                        <span>3</span>
                        <div>
                          <strong>Acompanhe por aqui</strong>
                          <p>Inventário e conexão em tempo real.</p>
                        </div>
                      </li>
                    </ol>
                    <div className="guide-security">
                      <ShieldCheck size={18} />
                      <p>
                        Sem abrir portas no roteador.
                        <br />
                        Cada dispositivo tem acesso individual.
                      </p>
                    </div>
                  </aside>
                )}
              </div>
              {page === "overview" && (
                <section className="recent-activity">
                  <div className="section-heading">
                    <h2>Atividade recente</h2>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPage("history")}
                    >
                      Ver atividade
                      <ArrowUpRight size={15} />
                    </Button>
                  </div>
                  <ActivityList
                    data={history.data?.slice(0, 3)}
                    error={history.error}
                  />
                </section>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              WakeBridge <span className="version">0.2</span>
            </span>
            <span>Feito para ficar sob seu controle.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function ActivityList({
  data,
  error,
}: {
  data?: Audit[];
  error: Error | null;
}) {
  if (error)
    return (
      <p className="error" role="alert">
        Não foi possível carregar a atividade.
      </p>
    );
  if (!data)
    return <div className="skeleton" aria-label="Carregando atividade" />;
  if (!data.length)
    return (
      <div className="activity-empty">
        <Activity size={18} />
        <p>As primeiras conexões e autorizações aparecerão aqui.</p>
      </div>
    );
  return (
    <ul className="activity-list">
      {data.map((a) => (
        <li key={a.id}>
          <span className="activity-icon">
            <ShieldCheck size={17} />
          </span>
          <span>{messages[a.action] ?? a.action}</span>
          <time dateTime={a.createdAt}>{date(a.createdAt)}</time>
        </li>
      ))}
    </ul>
  );
}

function Pairing({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [participateLan, setParticipateLan] = useState(false);
  const [server, setServer] = useState("");
  const client = useQueryClient();
  useEffect(() => setServer(location.origin), []);
  const inspect = useMutation({
    mutationFn: () =>
      api<{ name: string; platform: string }>(
        `workspaces/${workspaceId}/pairing/inspect`,
        { code },
      ),
  });
  const approve = useMutation({
    mutationFn: () =>
      api(`workspaces/${workspaceId}/pairing/approve`, { code }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["devices", workspaceId] });
      void client.invalidateQueries({ queryKey: ["history", workspaceId] });
    },
  });
  const command = `.\\wakebridge.exe pair --server ${server}${participateLan ? " --lan" : ""}`;
  return (
    <section className="pairing-surface" aria-labelledby="pairing-heading">
      <div className="section-heading">
        <h2 id="pairing-heading">Conectar um dispositivo</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Fechar pareamento"
          onClick={onClose}
        >
          <X size={18} />
        </Button>
      </div>
      {approve.isSuccess ? (
        <div className="pair-success" role="status">
          <Check size={24} />
          <div>
            <h3>Vínculo autorizado</h3>
            <p>
              Mantenha o agente aberto. O computador aparecerá assim que
              concluir a conexão.
            </p>
          </div>
          <Button variant="outline" onClick={onClose}>
            Concluir
          </Button>
        </div>
      ) : (
        <div className="pairing-columns">
          <div>
            <h3>Instale e abra o agente</h3>
            <p>
              Android / Android TV: instale o APK, informe a URL deste servidor
              e toque em Gerar código. Depois, confira o mesmo código neste
              painel.
            </p>
            <a
              className="download-link"
              href="/downloads/wakebridge-android-debug.apk"
              download
            >
              <ArrowDownToLine size={16} />
              Baixar APK Android de debug
            </a>
            <p>
              Baixe o executável para Windows 10/11, abra o PowerShell na pasta
              do arquivo e execute:
            </p>
            <label className="consent-checkbox">
              <input
                type="checkbox"
                checked={participateLan}
                onChange={(e) => setParticipateLan(e.target.checked)}
              />
              Permitir descoberta e emissão Wake-on-LAN no agente Windows.
              Depois do vínculo, autorize o relé nos detalhes do dispositivo.
            </label>
            <div className="code-command">
              <code>{command}</code>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Copiar comando"
                onClick={() => {
                  void navigator.clipboard.writeText(command).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </Button>
            </div>
            <a
              className="download-link"
              href="/downloads/wakebridge.exe"
              download
            >
              <ArrowDownToLine size={16} />
              Baixar agente Windows
            </a>
            <p className="muted">
              Para execução contínua após o boot, use o instalador de serviço
              descrito no README. O pareamento não exige direitos de
              administrador.
            </p>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              inspect.mutate();
            }}
          >
            <h3>Confira o código do agente</h3>
            <p>
              O código é temporário. Só autorize um computador que você
              reconhece.
            </p>
            <label>
              Código de pareamento
              <input
                name="code"
                autoComplete="off"
                inputMode="numeric"
                placeholder="1234-5678"
                maxLength={9}
                pattern="[0-9]{4}-[0-9]{4}"
                value={code}
                onChange={(e) => {
                  let value = e.target.value.replace(/\D/g, "").slice(0, 8);
                  if (value.length > 4)
                    value = value.slice(0, 4) + "-" + value.slice(4);
                  setCode(value);
                  inspect.reset();
                  approve.reset();
                }}
                required
              />
            </label>
            {inspect.data && (
              <div className="pair-device">
                <Monitor size={22} />
                <div>
                  <strong>{inspect.data.name}</strong>
                  <span>Windows · acesso exclusivo a este espaço</span>
                </div>
              </div>
            )}
            {(inspect.error ?? approve.error) && (
              <p className="error" role="alert">
                {(inspect.error ?? approve.error)?.message}
              </p>
            )}
            {inspect.data ? (
              <Button
                type="button"
                disabled={approve.isPending}
                onClick={() => approve.mutate()}
              >
                <ShieldCheck size={17} />
                Autorizar este computador
              </Button>
            ) : (
              <Button type="submit" disabled={inspect.isPending}>
                {inspect.isPending ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <>
                    Conferir dispositivo
                    <ArrowRight size={17} />
                  </>
                )}
              </Button>
            )}
          </form>
        </div>
      )}
    </section>
  );
}

function DeviceDetails({
  device: d,
  workspaceId,
  canManage,
  canWake,
  onClose,
}: {
  device: DeviceView;
  workspaceId: string;
  canManage: boolean;
  canWake: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const observations = useQuery({
    queryKey: ["observations", workspaceId, d.id],
    queryFn: () =>
      api<{ id: string; state: string; reason: string; createdAt: string }[]>(
        `workspaces/${workspaceId}/devices/${d.id}/observations`,
      ),
    refetchInterval: 10000,
  });
  const revoke = useMutation({
    mutationFn: () =>
      api(`workspaces/${workspaceId}/devices/${d.id}/revoke`, {}),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["devices", workspaceId] });
      void client.invalidateQueries({ queryKey: ["history", workspaceId] });
    },
  });
  return (
    <aside className="detail-panel">
      <div className="section-heading">
        <h2>{d.name}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Fechar detalhes"
          onClick={onClose}
        >
          <X size={18} />
        </Button>
      </div>
      <p className="muted">
        {d.status === "online"
          ? "Conexão autenticada ativa"
          : "Sem conexão ativa. Inventário preservado."}
      </p>
      <dl>
        <dt>Último contato</dt>
        <dd>{date(d.lastSeen)}</dd>
        <dt>Sistema</dt>
        <dd>{d.osVersion ?? "Aguardando inventário"}</dd>
        <dt>Processador</dt>
        <dd>{d.cpu ?? "Não informado"}</dd>
        <dt>Memória</dt>
        <dd>
          {d.memoryBytes
            ? `${(Number(d.memoryBytes) / 1024 ** 3).toFixed(1)} GB`
            : "Não informada"}
        </dd>
        <dt>Agente</dt>
        <dd>{d.agentVersion ?? "Aguardando"}</dd>
      </dl>
      <h3>Interfaces conhecidas</h3>
      {d.interfaces.length ? (
        d.interfaces.map((n) => (
          <div className="network-interface" key={n.id}>
            <strong>{n.name}</strong>
            <code>{n.mac ?? "MAC indisponível"}</code>
            {n.addresses.map((a) => (
              <code key={a.address}>
                {a.address}/{a.prefixLength}
              </code>
            ))}
            <span>
              {n.present ? "No último inventário" : "Interface anterior"} · WoL{" "}
              {n.wolSupport === "unknown"
                ? "não verificado"
                : "requer teste físico"}
            </span>
          </div>
        ))
      ) : (
        <p className="muted">O agente ainda não enviou interfaces.</p>
      )}
      <RelayControls
        device={d}
        workspaceId={workspaceId}
        canManage={canManage}
        canWake={canWake}
      />
      <h3>Conexões recentes</h3>
      {observations.error ? (
        <p className="error">Não foi possível carregar as conexões.</p>
      ) : (
        <ul className="observations">
          {observations.data?.slice(0, 5).map((o) => (
            <li key={o.id}>
              <span className={`status-indicator ${o.state}`} />
              {o.state === "online" ? "Conectado" : "Offline"}
              <time>{date(o.createdAt)}</time>
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <AlertDialog.Root>
          <AlertDialog.Trigger asChild>
            <Button variant="outline" className="revoke-button">
              <Unplug size={16} />
              Revogar acesso
            </Button>
          </AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="dialog-overlay" />
            <AlertDialog.Content className="dialog-content">
              <AlertDialog.Title>Revogar acesso de {d.name}?</AlertDialog.Title>
              <AlertDialog.Description>
                O agente será desconectado e precisará de um novo pareamento. O
                inventário continuará salvo neste espaço.
              </AlertDialog.Description>
              <div className="dialog-actions">
                <AlertDialog.Cancel asChild>
                  <Button variant="outline">Cancelar</Button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <Button variant="destructive" onClick={() => revoke.mutate()}>
                    Revogar acesso
                  </Button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      )}
      {revoke.error && (
        <p className="error" role="alert">
          {revoke.error.message}
        </p>
      )}
      {revoke.isSuccess && (
        <p className="pair-success" role="status">
          Acesso revogado. Inventário preservado.
        </p>
      )}
    </aside>
  );
}
