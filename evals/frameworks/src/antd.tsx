// A plain Ant Design form. Framework state is mirrored to window.__values, so the
// test can tell a real state update from text that merely appears on screen.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AutoComplete, Button, Cascader, Checkbox, DatePicker, Form, Input, InputNumber, Radio, Select, TreeSelect } from 'antd';

const CITIES = ['北京', '上海', '深圳', '杭州'].map((value) => ({ value, label: value }));
const REGIONS = [
  { value: '广东省', label: '广东省', children: [
    { value: '深圳市', label: '深圳市', children: [{ value: '南山区', label: '南山区' }, { value: '福田区', label: '福田区' }] },
    { value: '广州市', label: '广州市', children: [{ value: '天河区', label: '天河区' }] },
  ] },
  { value: '浙江省', label: '浙江省', children: [
    { value: '杭州市', label: '杭州市', children: [{ value: '西湖区', label: '西湖区' }] },
  ] },
];
const DEGREES = ['本科', '硕士', '博士'].map((value) => ({ value, label: value }));
const TREE = [
  { value: '技术', title: '技术', children: [{ value: 'Engineering', title: 'Engineering' }, { value: 'QA', title: 'QA' }] },
  { value: '职能', title: '职能', children: [{ value: 'HR', title: 'HR' }] },
];

function App() {
  return (
    <Form
      layout="vertical"
      style={{ maxWidth: 560, margin: 24 }}
      onValuesChange={(_changed, all) => {
        (window as any).__values = JSON.parse(JSON.stringify(all));
      }}
      onFinish={() => {
        (window as any).__submitted = true;
      }}
    >
      <Form.Item label="姓名" name="name"><Input /></Form.Item>
      <Form.Item label="邮箱" name="email"><Input /></Form.Item>
      <Form.Item label="性别" name="gender">
        <Radio.Group options={['男', '女']} />
      </Form.Item>
      <Form.Item label="工作城市" name="city"><Select options={CITIES} placeholder="请选择" /></Form.Item>
      <Form.Item label="最高学历" name="degree"><Select showSearch options={DEGREES} placeholder="可搜索" /></Form.Item>
      <Form.Item label="所在地区" name="region"><Cascader options={REGIONS} placeholder="请选择" /></Form.Item>
      <Form.Item label="入职日期" name="joined"><DatePicker /></Form.Item>
      <Form.Item label="工作年限" name="years"><InputNumber /></Form.Item>
      <Form.Item label="编程语言" name="skills">
        <Checkbox.Group options={['JavaScript', 'Python', 'Go', 'Rust']} />
      </Form.Item>
      <Form.Item label="所属部门" name="dept"><TreeSelect treeData={TREE} treeDefaultExpandAll placeholder="请选择" /></Form.Item>
      <Form.Item label="公司名称" name="company">
        <AutoComplete options={[{ value: 'Example Technology' }, { value: 'Acme Corp' }]} placeholder="输入公司名" />
      </Form.Item>
      <Form.Item label="个人简介" name="bio"><Input.TextArea rows={2} /></Form.Item>
      <Form.Item><Button type="primary" htmlType="submit">提交</Button></Form.Item>
    </Form>
  );
}

(window as any).__values = {};
(window as any).__submitted = false;
createRoot(document.getElementById('root')!).render(<App />);
