import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ open, title, body, confirmLabel, destructive, onConfirm, onClose }: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">
          {body}
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button
          variant="contained"
          color={destructive ? 'error' : 'primary'}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
