import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/auth/AuthProvider'
import { ComingSoon } from './ComingSoon'

export default function DashboardPage() {
  const { merchant } = useAuth()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Welcome back, {merchant?.businessName}</h1>
        <p className="text-sm text-muted-foreground">{merchant?.email}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Signed in</CardTitle>
          <CardDescription>Auth is wired to the real API — balance card and recent payments land in step 4.</CardDescription>
        </CardHeader>
        <CardContent>
          <ComingSoon title="Balance card + recent payments" step="Coming in step 4" />
        </CardContent>
      </Card>
    </div>
  )
}
