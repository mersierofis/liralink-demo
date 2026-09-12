import { ComingSoon } from './ComingSoon'

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <ComingSoon title="Business name, IBAN, auto-save slider" step="Coming in step 6" />
    </div>
  )
}
