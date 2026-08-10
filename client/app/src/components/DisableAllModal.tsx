/** DisableAllModal — shown when user attempts to save with all triggers off. */
interface Props {
  onConfirm: () => void
  onCancel: () => void
}

export function DisableAllModal({ onConfirm, onCancel }: Props) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="disable-all-title">
      <div className="modal">
        <h2 id="disable-all-title">No triggers enabled</h2>
        <p>
          RAKSHA will not respond to any gesture.
          You will not be able to silently activate an SOS without re-enabling a trigger.
          Are you sure?
        </p>
        <div className="stack-sm">
          <button id="disable-all-confirm" className="btn btn-primary" onClick={onConfirm}>
            Yes, disable all
          </button>
          <button id="disable-all-cancel" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
