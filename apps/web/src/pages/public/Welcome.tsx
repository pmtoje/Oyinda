import { Link } from 'react-router-dom';
import { AuthLayout } from '../../components/Shells';

const OPEN_ACCOUNT = (import.meta.env.VITE_ACCOUNT_OPENING_URL as string | undefined) || 'https://altbank.ng';

export default function Welcome() {
  return (
    <AuthLayout heading="Corporate financing, structured the non-interest way." text="Request Shariah-compliant facilities, track every stage of the review and respond to your offer in one place.">
      <div className="stack">
        <div>
          <h2>Get started</h2>
          <p className="muted">Do you have an Alternative Bank account?</p>
        </div>
        <Link to="/onboarding" className="choice" style={{ textDecoration: 'none' }}>
          <div className="title">Yes, I have an account</div>
          <div className="desc">Verify your business account number and set up access to Gazelle. Takes about 3 minutes.</div>
        </Link>
        <a href={OPEN_ACCOUNT} className="choice" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
          <div className="title">No, open an account</div>
          <div className="desc">Opens the Alternative Bank account-opening journey on altbank.ng (external site). Return here once your business account is active.</div>
        </a>
        <hr className="divider" />
        <div className="row between small">
          <span>Already registered? <Link to="/login">Sign in</Link></span>
          <Link to="/staff/login" className="muted">Bank staff sign-in</Link>
        </div>
      </div>
    </AuthLayout>
  );
}
