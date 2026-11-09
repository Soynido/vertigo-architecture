import hashlib,unittest
from scan_secrets import classify,scan_passed

class ExactClassification(unittest.TestCase):
 def setUp(self):
  self.line='logical_key: "DEMO/RUNTIME"'
  self.finding={'File':'fixtures/example.ts','RuleID':'generic-api-key'}
  self.entries=[{'path':'fixtures/example.ts','rule_id':'generic-api-key','line_sha256':hashlib.sha256(self.line.encode()).hexdigest()}]
 def test_reviewed_exact_line(self):self.assertEqual(classify(self.finding,self.line,self.entries),'NON_SECRET_CODE_IDENTIFIER')
 def test_changed_value_requires_review(self):self.assertEqual(classify(self.finding,self.line+' // changed',self.entries),'REQUIRES_REVIEW')
 def test_other_file_requires_review(self):self.assertEqual(classify({**self.finding,'File':'other.ts'},self.line,self.entries),'REQUIRES_REVIEW')
 def test_other_detector_requires_review(self):self.assertEqual(classify({**self.finding,'RuleID':'provider-specific-key'},self.line,self.entries),'REQUIRES_REVIEW')
 def test_multiline_finding_requires_review(self):self.assertEqual(classify({**self.finding,'StartLine':4,'EndLine':5},self.line,self.entries),'REQUIRES_REVIEW')

class ScannerOutcome(unittest.TestCase):
 def test_clean_report(self):self.assertTrue(scan_passed(0,True,0,0))
 def test_classified_findings_report(self):self.assertTrue(scan_passed(42,True,6,0))
 def test_missing_report_is_failure(self):self.assertFalse(scan_passed(0,False,0,0))
 def test_scanner_error_is_failure(self):self.assertFalse(scan_passed(1,True,0,0))
 def test_scanner_error_without_report_is_failure(self):self.assertFalse(scan_passed(1,False,0,0))
 def test_findings_exit_without_findings_is_failure(self):self.assertFalse(scan_passed(42,True,0,0))
 def test_clean_exit_with_findings_is_failure(self):self.assertFalse(scan_passed(0,True,1,0))
 def test_unreviewed_findings_is_failure(self):self.assertFalse(scan_passed(42,True,1,1))

if __name__=='__main__':unittest.main()
