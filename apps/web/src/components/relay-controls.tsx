"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Power, Radio, ShieldCheck } from "lucide-react";
import type { DeviceView } from "@wakebridge/shared";
import { api } from "@/lib/api";
import { Button } from "./ui/button";
type Link = {
  id: string;
  relayId: string;
  evidence: string;
  unavailableReason: string | null;
  relay: { name: string; platform: string };
};
type Operation = {
  id: string;
  kind: string;
  state: string;
  reason: string | null;
  createdAt: string;
  target: { name: string };
  attempts: {
    id: string;
    state: string;
    reason: string | null;
    relay: { name: string; platform: string };
  }[];
};
const labels: Record<string, string> = {
  QUEUED: "Na fila",
  SENT: "Comando enviado",
  WAITING: "Aguardando inicialização",
  ONLINE: "Online confirmado",
  FAILED: "Falhou",
  UNCONFIRMED: "Inicialização não confirmada",
  EXECUTED: "Pacote de teste enviado",
};
const reasons: Record<string, string> = {
  relay_offline_or_old_protocol: "Relé offline ou precisa de atualização",
  relay_not_approved: "Relé sem autorização do administrador",
  lan_disabled: "Participação LAN desativada no agente",
  udp_unsupported: "Envio UDP indisponível",
  network_changed:
    "Valide o vínculo após mudança de rede ou reinício do agente",
  interface_changed: "A interface mudou; valide novamente",
  evidence_expired: "Teste de conectividade expirado",
};
export function RelayControls({
  device,
  workspaceId,
  canManage,
  canWake,
}: {
  device: DeviceView;
  workspaceId: string;
  canManage: boolean;
  canWake: boolean;
}) {
  const client = useQueryClient();
  const [manual, setManual] = useState(false);
  const base = `workspaces/${workspaceId}`;
  const relays = useQuery({
    queryKey: ["relays", workspaceId, device.id],
    queryFn: () => api<Link[]>(`${base}/devices/${device.id}/relays`),
    refetchInterval: 5000,
  });
  const devices = useQuery({
    queryKey: ["devices", workspaceId],
    queryFn: () => api<DeviceView[]>(`${base}/devices`),
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["relays", workspaceId] });
    void client.invalidateQueries({ queryKey: ["operations", workspaceId] });
    void client.invalidateQueries({ queryKey: ["devices", workspaceId] });
    void client.invalidateQueries({ queryKey: ["networks", workspaceId] });
  };
  const wake = useMutation({
    mutationFn: () =>
      api<Operation>(`${base}/devices/${device.id}/wake`, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: refresh,
  });
  const policy = useMutation({
    mutationFn: () =>
      api(`${base}/devices/${device.id}/relay-policy`, {
        approved: !device.relayApproved,
        priority: device.relayPriority,
      }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: (linkId: string) =>
      api(`${base}/devices/${device.id}/relay-test`, {
        linkId,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: refresh,
  });
  const associate = useMutation({
    mutationFn: (data: {
      relayId: string;
      relayInterfaceId: string;
      targetInterfaceId: string;
    }) =>
      api(`${base}/devices/${device.id}/manual-relay`, {
        ...data,
        confirmSameLan: true,
      }),
    onSuccess: () => {
      refresh();
      setManual(false);
    },
  });
  const eligible = relays.data?.filter((l) => !l.unavailableReason) ?? [];
  const [relayId, setRelayId] = useState("");
  const selected = devices.data?.find((d) => d.id === relayId);
  const error =
    wake.error ?? policy.error ?? test.error ?? associate.error ?? relays.error;
  return (
    <section className="relay-controls">
      <h3>Wake-on-LAN</h3>
      {device.platform === "windows" && (
        <>
          <p className="muted">
            Um agente autorizado da mesma LAN envia o pacote. Só a reconexão
            deste computador confirma o retorno.
          </p>
          {canWake && (
            <Button
              className="wake-button"
              disabled={
                wake.isPending ||
                device.status === "online" ||
                eligible.length === 0
              }
              onClick={() => wake.mutate()}
            >
              {wake.isPending ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Power size={16} />
              )}
              Ligar computador
            </Button>
          )}
          {wake.data && (
            <p className="operation-feedback" role="status">
              {labels[wake.data.state] ?? wake.data.state}
            </p>
          )}
          {!eligible.length && !relays.isPending && (
            <p className="muted">
              Nenhum relé elegível agora. Confira as autorizações, a conexão dos
              agentes e os testes de rede.
            </p>
          )}
          <ul className="relay-list">
            {relays.data?.map((link) => (
              <li key={link.id}>
                <strong>{link.relay.name}</strong>
                <span>
                  {link.evidence === "AUTHENTICATED"
                    ? "Conectividade autenticada"
                    : "Vínculo manual"}
                </span>
                <p>
                  {link.unavailableReason
                    ? (reasons[link.unavailableReason] ?? "Relé indisponível")
                    : "Disponível para enviar WoL"}
                </p>
                {canWake && !link.unavailableReason && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={test.isPending}
                    onClick={() => test.mutate(link.id)}
                  >
                    Testar emissão do pacote
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {canManage && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setManual(!manual)}
            >
              Configurar relé manualmente
            </Button>
          )}
          {manual && (
            <form
              className="manual-relay"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                associate.mutate({
                  relayId: String(data.get("relayId")),
                  relayInterfaceId: String(data.get("relayInterfaceId")),
                  targetInterfaceId: String(data.get("targetInterfaceId")),
                });
              }}
            >
              <label>
                Agente relé
                <select
                  name="relayId"
                  value={relayId}
                  required
                  onChange={(e) => setRelayId(e.target.value)}
                >
                  <option value="">Selecione</option>
                  {devices.data
                    ?.filter(
                      (d) =>
                        d.id !== device.id &&
                        d.status === "online" &&
                        d.lanEnabled &&
                        d.relayApproved,
                    )
                    .map((d) => (
                      <option value={d.id} key={d.id}>
                        {d.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Interface do relé
                <select name="relayInterfaceId" required key={relayId}>
                  <option value="">Selecione</option>
                  {selected?.interfaces
                    .filter((n) => n.present && n.isUp)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name} · {n.addresses[0]?.address}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Interface do computador
                <select name="targetInterfaceId" required>
                  <option value="">Selecione</option>
                  {device.interfaces
                    .filter((n) => n.mac && n.present)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name} · {n.mac}
                      </option>
                    ))}
                </select>
              </label>
              <label className="consent-checkbox">
                <input type="checkbox" required />
                Confirmo que as interfaces estão na mesma LAN e autorizo o teste
                de emissão. Este vínculo manual não comprova conectividade.
              </label>
              <Button type="submit" disabled={associate.isPending}>
                Salvar vínculo manual
              </Button>
            </form>
          )}
        </>
      )}
      {canManage && (
        <div className="relay-policy">
          <h3>Participação como relé</h3>
          <p className="muted">
            No agente, habilite o acesso à LAN. Aqui, autorize o uso dele para
            descoberta e WoL neste espaço.
          </p>
          <p className="muted">
            LAN no agente:{" "}
            {device.lanEnabled ? "habilitada" : "desativada ou indisponível"} ·
            uso no espaço:{" "}
            {device.relayApproved ? "autorizado" : "não autorizado"}
          </p>
          <Button
            variant="outline"
            disabled={policy.isPending}
            onClick={() => policy.mutate()}
          >
            <ShieldCheck size={16} />
            {device.relayApproved ? "Desautorizar relé" : "Autorizar como relé"}
          </Button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error.message}
        </p>
      )}
    </section>
  );
}
export function Operations({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({
    queryKey: ["operations", workspaceId],
    queryFn: () => api<Operation[]>(`workspaces/${workspaceId}/operations`),
    refetchInterval: 3000,
  });
  return (
    <section className="operations-surface">
      <h2>Operações de Wake-on-LAN</h2>
      {query.isPending ? (
        <p className="muted">Carregando operações…</p>
      ) : query.error ? (
        <p className="error">{query.error.message}</p>
      ) : !query.data?.length ? (
        <p className="muted">
          As solicitações para ligar e testar os computadores aparecerão aqui.
        </p>
      ) : (
        <ul className="operation-list">
          {query.data.slice(0, 30).map((op) => (
            <li key={op.id}>
              <div>
                <strong>{op.target.name}</strong>
                <span
                  className={`operation-state state-${op.state.toLowerCase()}`}
                >
                  {labels[op.state] ?? op.state}
                </span>
              </div>
              <p>
                {op.kind === "RELAY_TEST"
                  ? "Teste de emissão UDP; não confirma que o computador ligou."
                  : op.reason === "no_eligible_relay"
                    ? "Não há agente autorizado e disponível na LAN deste computador."
                    : op.reason === "boot_not_observed"
                      ? "O computador não retornou dentro do prazo. Confira o hardware e a configuração de WoL."
                      : op.reason === "already_online"
                        ? "O agente já estava online. Nenhum pacote foi necessário."
                        : op.reason === "agent_reconnected"
                          ? "O agente do computador se reconectou ao servidor."
                          : "Acompanhando a operação."}
              </p>
              {op.attempts.map((a) => (
                <p className="attempt" key={a.id}>
                  {a.relay.name} ·{" "}
                  {a.relay.platform === "android" ? "Android" : "Windows"} ·{" "}
                  {a.state === "PACKET_SENT"
                    ? "pacote enviado"
                    : a.state === "UNCERTAIN"
                      ? "envio não confirmado"
                      : a.state === "FAILED"
                        ? "tentativa falhou"
                        : "comando enviado"}
                </p>
              ))}
              <time>{new Date(op.createdAt).toLocaleString("pt-BR")}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
export function Networks({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["networks", workspaceId],
    queryFn: () =>
      api<{
        domains: {
          id: string;
          members: { id: string; name: string; online: boolean }[];
        }[];
        manualLinks: { id: string; relay: string; target: string }[];
        tests: { id: string; state: string }[];
      }>(`workspaces/${workspaceId}/networks`),
    refetchInterval: 5000,
  });
  const discover = useMutation({
    mutationFn: () =>
      api<{ issued: number }>(`workspaces/${workspaceId}/discovery`, {}),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["networks", workspaceId] });
    },
  });
  return (
    <section className="networks-surface">
      <div className="section-heading">
        <h2>Conectividade e relés</h2>
        {canManage && (
          <Button
            variant="outline"
            disabled={discover.isPending}
            onClick={() => discover.mutate()}
          >
            <Radio size={16} />
            Testar descoberta
          </Button>
        )}
      </div>
      <p className="muted">
        As redes abaixo exigem um desafio local autenticado confirmado pelos
        dois agentes. O IP público não define esses grupos. Autorize a
        participação nos detalhes de cada dispositivo.
      </p>
      {query.error && <p className="error">{query.error.message}</p>}
      {discover.error && <p className="error">{discover.error.message}</p>}
      {discover.data && (
        <p className="muted" role="status">
          {discover.data.issued
            ? `${discover.data.issued} testes iniciados.`
            : "Nenhum novo teste elegível. Confira a LAN e as autorizações, ou aguarde um minuto após a última tentativa."}
        </p>
      )}
      {!query.data?.domains.length && (
        <div className="activity-empty">
          <Radio size={20} />
          <p>
            Nenhuma rede comprovada ainda. Mantenha dois agentes autorizados
            online na mesma LAN para validar a comunicação.
          </p>
        </div>
      )}
      {query.data?.domains.map((domain, index) => (
        <article className="network-domain" key={domain.id}>
          <h3>Rede verificada {index + 1}</h3>
          <ul>
            {domain.members.map((member) => (
              <li key={member.id}>
                <span
                  className={`status-indicator ${member.online ? "online" : "offline"}`}
                />
                {member.name}
                <span className="muted">
                  {member.online ? "Online" : "Offline"}
                </span>
              </li>
            ))}
          </ul>
        </article>
      ))}
      {!!query.data?.manualLinks.length && (
        <div className="manual-network-links">
          <h3>Vínculos manuais</h3>
          {query.data.manualLinks.map((l) => (
            <p key={l.id}>
              {l.relay} → {l.target}
            </p>
          ))}
        </div>
      )}
      <p className="muted">
        Testes recentes: {query.data?.tests.length ?? 0}. Descoberta bloqueada
        por isolamento Wi-Fi ou VLAN exige corrigir a conectividade ou autorizar
        um vínculo manual para teste.
      </p>
    </section>
  );
}
