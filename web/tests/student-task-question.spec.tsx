import { render, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { StudentTaskQuestionText } from '@/components/learning/student-tasks/StudentTaskPlayerPage'

it('renders existing math markup without enabling teacher-provided scripts or external images', async () => {
  const { container } = render(<StudentTaskQuestionText content={'求 $\\frac{1}{2}+\\frac{1}{3}$。\n\n<script>window.untrustedQuestion=true</script>\n\n![external](https://untrusted.invalid/image.png)'} />)
  // KaTeX and its remark/rehype plugins are lazy imports. A parallel production
  // build can contend with this test worker; wait for rendered math itself.
  await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull(), { timeout: 5000 })
  expect(container).not.toHaveTextContent('$\\frac{1}{2}')
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('img')).toBeNull()
  expect((window as Window & { untrustedQuestion?: boolean }).untrustedQuestion).toBeUndefined()
}, 10000)
