import React, { type CSSProperties, type ReactNode } from "react";
import { theme } from "@haf/shared";

type Children = {
  children: ReactNode;
};

export function AppShell({ children }: Children) {
  return <div style={{ minHeight: "100vh", color: theme.text }}>{children}</div>;
}

export function WorkspacePanel({
  title,
  subtitle,
  footer,
  children
}: Children & {
  title: string;
  subtitle?: string;
  footer?: ReactNode;
}) {
  return (
    <section
      style={{
        background: theme.panel,
        border: `1px solid ${theme.border}`,
        display: "flex",
        flexDirection: "column",
        minHeight: 0
      }}
    >
      <div style={{ padding: "14px 14px 10px", borderBottom: `1px solid ${theme.border}` }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: theme.muted,
            marginBottom: 6
          }}
        >
          {title}
        </div>
        {subtitle ? <div style={{ fontSize: 13, color: theme.muted }}>{subtitle}</div> : null}
      </div>

      <div style={{ padding: 14, overflow: "auto", flex: 1 }}>{children}</div>

      {footer ? (
        <div style={{ padding: 14, borderTop: `1px solid ${theme.border}` }}>{footer}</div>
      ) : null}
    </section>
  );
}

export function SidebarSection({ title, children }: Children & { title: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          marginBottom: 10,
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: theme.muted
        }}
      >
        {title}
      </div>
      <div style={{ display: "grid", gap: 10 }}>{children}</div>
    </div>
  );
}

export function BlackButton({
  children,
  subdued = false,
  onClick,
  disabled = false,
  style
}: Children & {
  subdued?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%",
        background: subdued ? "rgba(17,17,17,0.88)" : theme.black,
        color: theme.white,
        border: "none",
        height: 42,
        padding: "0 14px",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        fontSize: 12,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.72 : 1,
        ...style
      }}
    >
      {children}
    </button>
  );
}

export function InputField({
  label,
  value,
  type = "text",
  onChange
}: {
  label: string;
  value?: string | number;
  type?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 12, color: theme.muted }}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        style={{
          width: "100%",
          height: 38,
          border: `1px solid ${theme.border}`,
          background: "rgba(255,255,255,0.72)",
          padding: "0 10px",
          outline: "none",
          color: theme.text
        }}
      />
    </label>
  );
}

export function SelectField({
  label,
  defaultValue,
  options,
  onChange
}: {
  label: string;
  defaultValue?: string;
  options: Array<{ label: string; value: string }>;
  onChange?: (value: string) => void;
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 12, color: theme.muted }}>{label}</span>
      <select
        value={defaultValue}
        onChange={(event) => onChange?.(event.target.value)}
        style={{
          width: "100%",
          height: 38,
          border: `1px solid ${theme.border}`,
          background: "rgba(255,255,255,0.72)",
          padding: "0 10px",
          outline: "none",
          color: theme.text
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 0",
        borderBottom: `1px solid ${theme.border}`,
        fontSize: 13
      }}
    >
      <span style={{ color: theme.muted }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
