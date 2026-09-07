import { forwardRef } from 'react'
import { Button, type ButtonProps } from './button'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(
  ({ label, children, variant = 'ghost', ...props }, ref) => (
    <Tooltip><TooltipTrigger asChild><Button {...props} ref={ref} variant={variant} size="icon" aria-label={label}>{children}</Button></TooltipTrigger><TooltipContent sideOffset={6}>{label}</TooltipContent></Tooltip>
  ),
)
IconButton.displayName = 'IconButton'
