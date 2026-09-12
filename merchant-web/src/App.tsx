import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'

// Pages are added in the following build steps (03-MERCHANT-WEB.md):
// step 2 = auth + AppShell, step 3 = Links + Link detail, step 4 = Dashboard/Payments,
// step 5 = Withdrawals/Settings. Placeholder below only proves the scaffold boots.
function Placeholder({ title }: { title: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">LiraLink — merchant-web</h1>
        <p className="mt-2 text-muted-foreground">{title}</p>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Placeholder title="Login — coming in step 2" />} />
        <Route path="/" element={<Placeholder title="Dashboard — coming in step 4" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </BrowserRouter>
  )
}
