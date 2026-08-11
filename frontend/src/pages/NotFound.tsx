// Fallback route.
import { Link } from 'react-router-dom'
import { Compass } from 'lucide-react'

export default function NotFound() {
    return (
        <div className="page">
            <div className="empty" style={{ paddingTop: 80 }}>
                <div className="empty-icon">
                    <Compass size={28} />
                </div>
                <div className="empty-title">Page not found</div>
                <div className="empty-msg">
                    That route doesn’t exist. Head back to the overview.
                </div>
                <Link to="/" className="btn" style={{ marginTop: 16 }}>
                    Go to Overview
                </Link>
            </div>
        </div>
    )
}
