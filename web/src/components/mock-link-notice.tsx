import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// Mock mode sends no email; the link that would have been emailed is shown instead.
export function MockLinkNotice({ link, action }: { link: string; action: string }) {
  return (
    <Alert>
      <AlertTitle>Mock mode: no email was sent</AlertTitle>
      <AlertDescription>
        <a href={link} className="font-medium text-primary underline underline-offset-2">
          {action}
        </a>
      </AlertDescription>
    </Alert>
  );
}
