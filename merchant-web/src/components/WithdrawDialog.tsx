import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { useCreateWithdrawal } from '@/api/hooks'
import { HttpError } from '@/api/client'
import { formatTRY } from '@/lib/money'

const IBAN_REGEX = /^TR\d{24}$/

function buildSchema(availableTRY: number) {
  return z.object({
    amountTRY: z
      .string()
      .min(1, 'Amount is required')
      .refine((v) => {
        const n = Number(v)
        return Number.isFinite(n) && n > 0
      }, 'Enter a positive amount')
      .refine((v) => Number(v) <= availableTRY, `Cannot exceed your available balance (${formatTRY(availableTRY.toFixed(2))})`),
    iban: z.string().regex(IBAN_REGEX, 'IBAN must be TR followed by 24 digits'),
  })
}

export function WithdrawDialog({ availableTRY, defaultIban }: { availableTRY: string; defaultIban?: string }) {
  const [open, setOpen] = useState(false)
  const createWithdrawal = useCreateWithdrawal()
  const available = Number(availableTRY)
  const schema = buildSchema(available)

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { amountTRY: '', iban: defaultIban ?? '' },
  })

  const onSubmit = async (values: z.infer<typeof schema>) => {
    try {
      await createWithdrawal.mutateAsync({ amountTRY: Number(values.amountTRY).toFixed(2), iban: values.iban })
      toast.success('Withdrawal requested')
      setOpen(false)
      form.reset({ amountTRY: '', iban: values.iban })
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : 'Could not request the withdrawal.')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) form.reset()
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={available <= 0}>Withdraw</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Withdraw to IBAN</DialogTitle>
          <DialogDescription>Available balance: {formatTRY(availableTRY)}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="amountTRY"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount (TRY)</FormLabel>
                  <FormControl>
                    <Input inputMode="decimal" placeholder="1000" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="iban"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>IBAN</FormLabel>
                  <FormControl>
                    <Input placeholder="TR330006100519786457841326" {...field} />
                  </FormControl>
                  <FormDescription>TR followed by 24 digits.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={createWithdrawal.isPending}>
                {createWithdrawal.isPending ? 'Requesting…' : 'Request withdrawal'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
