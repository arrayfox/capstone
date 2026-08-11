// Route table. Layout renders the sidebar + top bar and an <Outlet> for the
// active page. Pipeline detail is its own full page (not a drawer), per the plan.

import { Route, Routes } from 'react-router-dom'
import Layout from './components/layout'
import Overview from './pages/Overview'
import Pipelines from './pages/Pipelines'
import PipelineDetail from './pages/PipelineDetail'
import Executions from './pages/Executions'
import Violations from './pages/Violations'
import Audit from './pages/Audit'
import NotFound from './pages/NotFound'

export default function App() {
    return (
        <Routes>
            <Route element={<Layout />}>
                <Route index element={<Overview />} />
                <Route path="pipelines" element={<Pipelines />} />
                <Route path="pipelines/:name" element={<PipelineDetail />} />
                <Route path="executions" element={<Executions />} />
                <Route path="violations" element={<Violations />} />
                <Route path="audit" element={<Audit />} />
                <Route path="*" element={<NotFound />} />
            </Route>
        </Routes>
    )
}
