import { useEffect, useRef, useState } from "react";
import { login, setAuthToken } from "../lib/api.js";
import "./login.css";

/**
 * 登录页与用户菜单
 * 认证走后端 `POST /api/auth/login`（users 表 + bcrypt + JWT）；
 * token 存 localStorage，由 lib/api.ts 在每次请求注入 `Authorization: Bearer`。
 */

export interface CurrentUser {
  username: string;
  displayName: string;
  role: "admin" | "on-call" | "viewer";
}

const ROLE_META: Record<CurrentUser["role"], { label: string; color: string }> = {
  admin: { label: "管理员", color: "#7c3aed" },
  "on-call": { label: "值班 SRE", color: "#2563eb" },
  viewer: { label: "只读观察", color: "#64748b" },
};

const STORAGE_KEY = "infrapilot.currentUser";

export function loadStoredUser(): CurrentUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CurrentUser) : null;
  } catch {
    return null;
  }
}

/** 清除本地登录态。token 由 lib/api.ts 的 clearAuthToken() 管理，两者必须一起清。 */
export function clearStoredUser(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/* ================= 登录页 ================= */

interface LoginPageProps {
  onLogin: (user: CurrentUser) => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState("oncall-zhang");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setError("请输入用户名");
      return;
    }
    if (!password.trim()) {
      setError("请输入密码");
      return;
    }
    setError(null);
    setLoggingIn(true);
    const res = await login(username.trim(), password, (err) => setError(err.message));
    setLoggingIn(false);
    if (!res) return;
    setAuthToken(res.token);
    onLogin({
      username: res.user.username,
      displayName: res.user.displayName,
      role: res.user.role,
    });
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__brand">
          <div className="login-card__logo">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <div>
            <div className="login-card__name">InfraPilot</div>
            <div className="login-card__sub">AI SRE 智能运维平台</div>
          </div>
        </div>

        <form className="login-card__form" onSubmit={submit}>
          <label className="login-field">
            <span>用户名</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="如 oncall-zhang" autoFocus />
          </label>
          <label className="login-field">
            <span>密码</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="请输入密码" />
          </label>
          {error && <div className="login-card__error">{error}</div>}
          <button className="login-card__btn" type="submit" disabled={loggingIn}>
            {loggingIn ? "登录中…" : "登录"}
          </button>
          <div className="login-card__hint">
            认证由后端 users 表 + JWT 提供，角色随账号下发。演示账号：admin/admin123 ·
            oncall-zhang/oncall123 · viewer/viewer123。
          </div>
        </form>
      </div>
    </div>
  );
}

/* ================= TopBar 用户菜单 ================= */

interface UserMenuProps {
  user: CurrentUser;
  onLogout: () => void;
}

export function UserMenu({ user, onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const role = ROLE_META[user.role];
  const initial = user.displayName.slice(0, 1).toUpperCase();

  return (
    <div className="user-menu" ref={ref}>
      <button className="user-menu__trigger" onClick={() => setOpen(!open)}>
        <span className="user-menu__avatar" style={{ background: role.color }}>{initial}</span>
        <span className="user-menu__name">{user.displayName}</span>
        <span className="user-menu__caret">▾</span>
      </button>
      {open && (
        <div className="user-menu__pop">
          <div className="user-menu__head">
            <div className="user-menu__title">{user.displayName}</div>
            <span className="user-menu__role" style={{ color: role.color }}>{role.label}</span>
          </div>
          <div className="user-menu__row"><span>用户名</span><code>{user.username}</code></div>
          <div className="user-menu__row"><span>审批权限</span><code>{user.role === "viewer" ? "无（只读）" : "有 · 双人审批生效"}</code></div>
          <button className="user-menu__logout" onClick={onLogout}>退出登录</button>
        </div>
      )}
    </div>
  );
}

export { ROLE_META };
