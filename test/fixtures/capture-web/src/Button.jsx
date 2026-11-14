export function Button({ label, variant = 'primary', onClick }) {
  return (
    <button type="button" className={variant === 'primary' ? 'btn' : 'btn secondary'} onClick={onClick}>
      {label}
    </button>
  );
}
