import { useEffect, useState } from "react";
import {
  deleteK8sCluster,
  testK8sCluster,
  upsertK8sCluster,
  type K8sCluster,
  type K8sClustersResponse,
} from "../../lib/api.js";

// ============================================================================
// 设置页 — 远端 K8s 集群接入
//
// 只读检查（list_pods / describe_pod / get_events ...）自动执行；变更类操作
// （如 patch_resource_limits）由 Policy Engine 定级后仍需人工审批，审批卡会标注目标集群。
// 未登记任何集群时 Agent 回退到进程内 kubeconfig（本地集群）。
// ============================================================================

const AUTH_OPTIONS: Array<{ value: K8sCluster["authType"]; label: string }> = [
  { value: "kubeconfig", label: "kubeconfig 文本" },
  { value: "token", label: "Bearer Token" },
  { value: "clientCert", label: "客户端证书" },
];

function emptyCluster(): K8sCluster {
  return { id: "", name: "", authType: "kubeconfig", kubeconfig: "", enabled: true };
}

export function K8sClusterSection({
  notify,
  clusters,
  onClustersChange,
  localFallback,
}: {
  notify: (msg: string, type?: "error" | "success") => void;
  clusters: K8sCluster[];
  onClustersChange: (clusters: K8sCluster[]) => void;
  localFallback?: boolean;
}) {
  return (
    <div className="ds-stack">
      <div className="settings-hint">
        Agent 可通过 <code>cluster</code> 参数指定目标集群执行检查；
        <strong>变更类操作（改资源配额、删 Pod 等）一律需要人工审批</strong>，审批卡会标注目标集群与 apiserver 地址。
        未登记任何集群时，Agent 使用进程内 kubeconfig（本地集群）。
      </div>
      {clusters.length === 0 && (
        <div className="empty-state">
          <div className="empty-state__icon">☸️</div>
          <div className="empty-state__message">
            {localFallback ? "暂无远端集群，当前使用本地集群（进程内 kubeconfig）" : "暂无远端集群"}
          </div>
        </div>
      )}
      {clusters.map((c) => (
        <ClusterCard key={c.id} cluster={c} notify={notify} onClustersChange={onClustersChange} />
      ))}
      <NewClusterForm notify={notify} onClustersChange={onClustersChange} />
    </div>
  );
}

function ClusterCard({
  cluster,
  notify,
  onClustersChange,
}: {
  cluster: K8sCluster;
  notify: (msg: string, type?: "error" | "success") => void;
  onClustersChange: (clusters: K8sCluster[]) => void;
}) {
  const [draft, setDraft] = useState(cluster);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(cluster), [cluster.id]);

  const apply = (res: (K8sClustersResponse & { ok: boolean }) | undefined, msg: string) => {
    if (res) {
      onClustersChange(res.clusters);
      notify(msg, "success");
    }
  };

  const save = async () => {
    setBusy(true);
    apply(await upsertK8sCluster(draft, (err) => notify(err.message)), "已保存");
    setBusy(false);
  };

  const setDefault = async () => {
    setBusy(true);
    apply(await upsertK8sCluster({ ...draft, isDefault: true }, (err) => notify(err.message)), "已设为默认集群");
    setBusy(false);
  };

  const remove = async () => {
    if (!confirm(`确定移除集群「${cluster.name}」吗？`)) return;
    const res = await deleteK8sCluster(cluster.id, (err) => notify(err.message));
    if (res) {
      onClustersChange(res.clusters);
      notify("已移除", "success");
    }
  };

  const test = async () => {
    setBusy(true);
    const r = await testK8sCluster(cluster.id, (err) => notify(err.message));
    setBusy(false);
    if (r) {
      notify(
        r.reachable ? `连接成功${r.serverVersion ? ` (${r.serverVersion})` : ""}` : `连接失败：${r.error ?? ""}`,
        r.reachable ? "success" : "error",
      );
    }
  };

  const authType = draft.authType;

  return (
    <div className="log-system-card">
      <div className="log-system-card__header">
        <div className="log-system-card__title">
          <input
            className="input input--inline log-system-card__name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <span className="tag">{AUTH_OPTIONS.find((o) => o.value === authType)?.label}</span>
          {cluster.isDefault && <span className="tag tag--accent">默认</span>}
        </div>
        <label className="toggle">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          <span className="toggle__track" />
          <span className="toggle__label">{draft.enabled ? "启用" : "禁用"}</span>
        </label>
      </div>

      <div className="log-system-card__body">
        <div className="form-grid form-grid--3">
          <Field label="认证方式">
            <select
              className="input"
              value={authType}
              onChange={(e) => setDraft({ ...draft, authType: e.target.value as K8sCluster["authType"] })}
            >
              {AUTH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          {authType !== "kubeconfig" && (
            <Field label="apiserver 地址">
              <input
                className="input"
                placeholder="https://10.0.0.1:6443"
                value={draft.server ?? ""}
                onChange={(e) => setDraft({ ...draft, server: e.target.value })}
              />
            </Field>
          )}
        </div>

        {authType === "kubeconfig" && (
          <Field label={cluster.hasKubeconfig ? "kubeconfig 文本（已配置，留空则沿用原值）" : "kubeconfig 文本"}>
            <textarea
              className="input textarea"
              rows={5}
              placeholder="apiVersion: v1&#10;clusters: ..."
              value={draft.kubeconfig ?? ""}
              onChange={(e) => setDraft({ ...draft, kubeconfig: e.target.value })}
            />
          </Field>
        )}

        {authType === "token" && (
          <div className="form-grid form-grid--3">
            <Field label={cluster.hasToken ? "访问令牌（已配置，留空则沿用原值）" : "访问令牌"}>
              <input
                className="input"
                type="password"
                placeholder="ServiceAccount Token"
                value={draft.token ?? ""}
                onChange={(e) => setDraft({ ...draft, token: e.target.value })}
              />
            </Field>
            <Field label="令牌环境变量（可选，优先级更高）">
              <input
                className="input"
                placeholder="K8S_PROD_TOKEN"
                value={draft.tokenEnv ?? ""}
                onChange={(e) => setDraft({ ...draft, tokenEnv: e.target.value })}
              />
            </Field>
          </div>
        )}

        {authType === "clientCert" && (
          <div className="form-grid form-grid--3">
            <Field label="客户端证书路径">
              <input
                className="input"
                placeholder="/etc/kubernetes/client.crt"
                value={draft.clientCert ?? ""}
                onChange={(e) => setDraft({ ...draft, clientCert: e.target.value })}
              />
            </Field>
            <Field label="客户端私钥路径">
              <input
                className="input"
                placeholder="/etc/kubernetes/client.key"
                value={draft.clientKey ?? ""}
                onChange={(e) => setDraft({ ...draft, clientKey: e.target.value })}
              />
            </Field>
          </div>
        )}

        {authType !== "kubeconfig" && (
          <div className="form-grid form-grid--3">
            <Field label={cluster.hasCaCert ? "CA 证书（已配置，留空则沿用原值）" : "CA 证书（可选）"}>
              <textarea
                className="input textarea"
                rows={2}
                placeholder="-----BEGIN CERTIFICATE-----"
                value={draft.caCert ?? ""}
                onChange={(e) => setDraft({ ...draft, caCert: e.target.value })}
              />
            </Field>
            <Field label="跳过 TLS 校验（自签名证书时勾选）">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={!!draft.insecureSkipTlsVerify}
                  onChange={(e) => setDraft({ ...draft, insecureSkipTlsVerify: e.target.checked })}
                />
                <span className="toggle__track" />
                <span className="toggle__label">{draft.insecureSkipTlsVerify ? "跳过校验" : "校验证书"}</span>
              </label>
            </Field>
          </div>
        )}
      </div>

      <div className="log-system-card__actions">
        <button className="btn btn--secondary" onClick={test} disabled={busy}>
          {busy ? "测试中..." : "连接测试"}
        </button>
        <button className="btn btn--primary" onClick={save} disabled={busy}>
          {busy ? "保存中..." : "保存"}
        </button>
        {!cluster.isDefault && (
          <button className="btn btn--secondary" onClick={setDefault} disabled={busy}>
            设为默认
          </button>
        )}
        <button className="btn btn--danger" onClick={remove}>
          移除
        </button>
      </div>
    </div>
  );
}

function NewClusterForm({
  notify,
  onClustersChange,
}: {
  notify: (msg: string, type?: "error" | "success") => void;
  onClustersChange: (clusters: K8sCluster[]) => void;
}) {
  const [draft, setDraft] = useState<K8sCluster>(emptyCluster());
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!draft.name.trim()) {
      notify("请填写集群名称");
      return;
    }
    setBusy(true);
    const res = await upsertK8sCluster(draft, (err) => notify(err.message));
    setBusy(false);
    if (res) {
      onClustersChange(res.clusters);
      setDraft(emptyCluster());
      notify("已添加集群", "success");
    }
  };

  return (
    <div className="log-system-card">
      <div className="log-system-card__header">
        <div className="log-system-card__title">
          <span className="log-system-card__name">+ 新增远端集群</span>
          <span className="tag">多集群</span>
        </div>
      </div>
      <div className="log-system-card__body">
        <div className="form-grid form-grid--3">
          <Field label="集群名称">
            <input
              className="input"
              placeholder="生产集群 A"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field label="认证方式">
            <select
              className="input"
              value={draft.authType}
              onChange={(e) => setDraft({ ...draft, authType: e.target.value as K8sCluster["authType"] })}
            >
              {AUTH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          {draft.authType !== "kubeconfig" && (
            <Field label="apiserver 地址">
              <input
                className="input"
                placeholder="https://10.0.0.1:6443"
                value={draft.server ?? ""}
                onChange={(e) => setDraft({ ...draft, server: e.target.value })}
              />
            </Field>
          )}
        </div>

        {draft.authType === "kubeconfig" && (
          <Field label="kubeconfig 文本">
            <textarea
              className="input textarea"
              rows={5}
              placeholder="apiVersion: v1&#10;clusters: ..."
              value={draft.kubeconfig ?? ""}
              onChange={(e) => setDraft({ ...draft, kubeconfig: e.target.value })}
            />
          </Field>
        )}

        {draft.authType === "token" && (
          <div className="form-grid form-grid--3">
            <Field label="访问令牌">
              <input
                className="input"
                type="password"
                placeholder="ServiceAccount Token"
                value={draft.token ?? ""}
                onChange={(e) => setDraft({ ...draft, token: e.target.value })}
              />
            </Field>
            <Field label="令牌环境变量（可选）">
              <input
                className="input"
                placeholder="K8S_PROD_TOKEN"
                value={draft.tokenEnv ?? ""}
                onChange={(e) => setDraft({ ...draft, tokenEnv: e.target.value })}
              />
            </Field>
          </div>
        )}

        {draft.authType === "clientCert" && (
          <div className="form-grid form-grid--3">
            <Field label="客户端证书路径">
              <input
                className="input"
                placeholder="/etc/kubernetes/client.crt"
                value={draft.clientCert ?? ""}
                onChange={(e) => setDraft({ ...draft, clientCert: e.target.value })}
              />
            </Field>
            <Field label="客户端私钥路径">
              <input
                className="input"
                placeholder="/etc/kubernetes/client.key"
                value={draft.clientKey ?? ""}
                onChange={(e) => setDraft({ ...draft, clientKey: e.target.value })}
              />
            </Field>
          </div>
        )}
      </div>
      <div className="log-system-card__actions">
        <button className="btn btn--primary" onClick={save} disabled={busy}>
          {busy ? "添加中..." : "添加集群"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  );
}
