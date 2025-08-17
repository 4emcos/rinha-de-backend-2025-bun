interface Payment {
  correlationId: string
  amount: number
}

interface DefaultPayment extends Payment {
  requestedAt: string
  requestedAtUnix: number
}

interface ProcessedPayment extends DefaultPayment {
  processed?: boolean
  useFallback?: boolean
}

interface PaymentRequestStats {
  success: boolean
  useFallback: boolean
}
