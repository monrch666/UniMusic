import { useState, useEffect } from "react";
import { MorphIcon } from "morphicons/react";
import { Disc3 } from "lucide";
import type { IconInput } from "morphicons";
export function Icon({
  icon,
  size = 20,
  className = "",
}: {
  icon: IconInput;
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={icon}
      size={size}
      strokeWidth={1.8}
      spring="snappy"
      reducedMotion="user"
      className={className}
      aria-hidden="true"
    />
  );
}
export function IconButton({
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
  className = "",
}: {
  icon: IconInput;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""} ${className}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon icon={icon} />
    </button>
  );
}
export function Cover({
  src,
  title,
  className = "",
}: {
  src?: string;
  title: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <div
      className={`cover ${className}`}
      title={title}
    >
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <Icon icon={Disc3} size={28} />
      )}
    </div>
  );
}

